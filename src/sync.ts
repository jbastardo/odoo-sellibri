import * as fs from 'fs';
import * as path from 'path';
import * as odoo from './odoo';
import * as sellibri from './sellibri';
import { config } from './config';
import { mapCategory } from './category-map';
import { logger } from './logger';

const MODULE = 'sync';
const STATE_FILE = path.join(process.cwd(), 'sync-state.json');

interface SyncState {
  lastProductSync: string | null;
  lastStockSync: string | null;
  lastProductWriteDate: string | null;
  lastStockWriteDate: string | null;
  products: Record<string, {
    sellibriId: number;
    sellibriVariantId: number;
    odooWriteDate: string;
    lastSynced: string;
  }>;
}

function loadState(): SyncState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (err: any) {
    logger.warn(MODULE, `Could not load sync state: ${err.message}`);
  }
  return {
    lastProductSync: null,
    lastStockSync: null,
    lastProductWriteDate: null,
    lastStockWriteDate: null,
    products: {},
  };
}

function saveState(state: SyncState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err: any) {
    logger.error(MODULE, `Could not save sync state: ${err.message}`);
  }
}

export interface SyncStatus {
  lastProductSync: string | null;
  lastStockSync: string | null;
  productsSynced: number;
  isRunning: boolean;
  lastError: string | null;
}

let syncStatus: SyncStatus = {
  lastProductSync: null,
  lastStockSync: null,
  productsSynced: 0,
  isRunning: false,
  lastError: null,
};

let productSyncRunning = false;
let stockSyncRunning = false;

export function getSyncStatus(): SyncStatus {
  return { ...syncStatus };
}

function buildSellibriPayload(
  product: odoo.OdooProduct,
  extraImages: odoo.ProductImage[],
): sellibri.SellibriProductPayload {
  const price = (product.list_price * (1 + config.ivaRate)).toFixed(2);
  const description = product.website_description || product.description_sale || '';
  const categId = Array.isArray(product.categ_id) ? product.categ_id[0] : 0;
  const taxonId = mapCategory(categId);

  const images: { image: string }[] = [];
  if (product.image_1920 && typeof product.image_1920 === 'string') {
    images.push({ image: product.image_1920 });
  }
  for (const img of extraImages) {
    if (img.image_1920 && typeof img.image_1920 === 'string') {
      images.push({ image: img.image_1920 });
    }
  }

  const variant: sellibri.SellibriVariant = {
    price,
    sku: product.default_code,
    barcode: product.barcode || undefined,
    weight: product.weight || undefined,
    width: null,
    height: null,
    length: null,
    track_inventory: true,
    tax_rate_id: config.sellibri.taxRateId,
    stock_items: [{
      stock_location_id: config.sellibri.stockLocationId,
      available: Math.max(0, Math.floor(product.qty_available || 0)),
    }],
  };

  if (images.length > 0) {
    variant.images = images;
  }

  return {
    product: {
      title: product.name,
      status: 'active',
      description: typeof description === 'string' ? description : '',
      all_variants: [variant],
      taxon_ids: [taxonId],
    },
  };
}

export async function syncProducts(): Promise<void> {
  if (productSyncRunning) {
    logger.warn(MODULE, 'Product sync already running, skipping');
    return;
  }
  productSyncRunning = true;
  syncStatus.isRunning = true;
  syncStatus.lastError = null;

  const state = loadState();
  let synced = 0;
  let errors = 0;

  try {
    logger.info(MODULE, 'Starting product sync');
    const lastWrite = state.lastProductWriteDate || undefined;
    const products = await odoo.fetchAllProducts(lastWrite);
    logger.info(MODULE, `Found ${products.length} products to sync`);

    let maxWriteDate = state.lastProductWriteDate || '';

    for (const product of products) {
      const sku = product.default_code;
      if (!sku) continue;

      try {
        // Check if product changed since last sync
        const cached = state.products[sku];
        if (cached && cached.odooWriteDate === product.write_date) {
          continue;
        }

        // Fetch extra images
        let extraImages: odoo.ProductImage[] = [];
        if (product.product_template_image_ids && product.product_template_image_ids.length > 0) {
          extraImages = await odoo.fetchProductImages(product.product_template_image_ids);
        }

        const payload = buildSellibriPayload(product, extraImages);

        // Check if exists in Sellibri
        const existing = cached?.sellibriId
          ? { id: cached.sellibriId, all_variants: [{ id: cached.sellibriVariantId }] } as any
          : await sellibri.findProductBySku(sku);

        let sellibriId: number;
        let variantId: number;

        if (existing) {
          // Update
          sellibriId = existing.id;
          const updated = await sellibri.updateProduct(sellibriId, payload);
          variantId = updated.all_variants?.[0]?.id || existing.all_variants?.[0]?.id || 0;
          logger.info(MODULE, `Updated product SKU=${sku} sellibriId=${sellibriId}`);
        } else {
          // Create
          const created = await sellibri.createProduct(payload);
          sellibriId = created.id;
          variantId = created.all_variants?.[0]?.id || 0;
          logger.info(MODULE, `Created product SKU=${sku} sellibriId=${sellibriId}`);
        }

        state.products[sku] = {
          sellibriId,
          sellibriVariantId: variantId,
          odooWriteDate: product.write_date,
          lastSynced: new Date().toISOString(),
        };
        synced++;

        if (product.write_date > maxWriteDate) {
          maxWriteDate = product.write_date;
        }

        // Save state periodically
        if (synced % 50 === 0) {
          saveState(state);
        }
      } catch (err: any) {
        errors++;
        logger.error(MODULE, `Error syncing SKU=${sku}: ${err.message}`);
      }
    }

    if (maxWriteDate) {
      state.lastProductWriteDate = maxWriteDate;
    }
    state.lastProductSync = new Date().toISOString();
    saveState(state);

    syncStatus.lastProductSync = state.lastProductSync;
    syncStatus.productsSynced = Object.keys(state.products).length;
    logger.info(MODULE, `Product sync complete: ${synced} synced, ${errors} errors`);
  } catch (err: any) {
    syncStatus.lastError = err.message;
    logger.error(MODULE, `Product sync failed: ${err.message}`);
  } finally {
    productSyncRunning = false;
    syncStatus.isRunning = stockSyncRunning;
  }
}

export async function syncStock(): Promise<void> {
  if (stockSyncRunning) {
    logger.warn(MODULE, 'Stock sync already running, skipping');
    return;
  }
  stockSyncRunning = true;
  syncStatus.isRunning = true;
  syncStatus.lastError = null;

  const state = loadState();
  let synced = 0;
  let errors = 0;

  try {
    logger.info(MODULE, 'Starting stock sync');

    // Get products that have been synced to Sellibri
    const trackedSkus = Object.keys(state.products);
    if (trackedSkus.length === 0) {
      logger.info(MODULE, 'No products tracked yet, skipping stock sync');
      return;
    }

    // Fetch products with updated stock from Odoo
    const lastWrite = state.lastStockWriteDate || undefined;
    const products = await odoo.fetchAllProducts(lastWrite);

    let maxWriteDate = state.lastStockWriteDate || '';

    for (const product of products) {
      const sku = product.default_code;
      if (!sku) continue;

      const cached = state.products[sku];
      if (!cached) continue;

      try {
        const available = Math.max(0, Math.floor(product.qty_available || 0));
        await sellibri.updateStockItem(
          cached.sellibriId,
          cached.sellibriVariantId,
          config.sellibri.stockLocationId,
          available,
        );
        synced++;
        logger.info(MODULE, `Updated stock SKU=${sku} qty=${available}`);

        if (product.write_date > maxWriteDate) {
          maxWriteDate = product.write_date;
        }
      } catch (err: any) {
        errors++;
        logger.error(MODULE, `Error updating stock SKU=${sku}: ${err.message}`);
      }
    }

    if (maxWriteDate) {
      state.lastStockWriteDate = maxWriteDate;
    }
    state.lastStockSync = new Date().toISOString();
    saveState(state);

    syncStatus.lastStockSync = state.lastStockSync;
    logger.info(MODULE, `Stock sync complete: ${synced} updated, ${errors} errors`);
  } catch (err: any) {
    syncStatus.lastError = err.message;
    logger.error(MODULE, `Stock sync failed: ${err.message}`);
  } finally {
    stockSyncRunning = false;
    syncStatus.isRunning = productSyncRunning;
  }
}
