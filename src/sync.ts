import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as odoo from './odoo';
import * as sellibri from './sellibri';
import { config } from './config';
import { mapCategory } from './category-map';
import { logger } from './logger';

const MODULE = 'sync';
const STATE_FILE = path.join(process.cwd(), 'sync-state.json');

interface ProductSyncEntry {
  sellibriId: number;
  sellibriVariantId: number;
  odooWriteDate: string;
  lastSynced: string;
  imageHash?: string;
  lastStock?: number;
}

interface SyncState {
  lastProductSync: string | null;
  lastStockSync: string | null;
  lastProductWriteDate: string | null;
  lastStockWriteDate: string | null;
  products: Record<string, ProductSyncEntry>;
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

/** Generate a short hash of image data for change detection */
function imageHash(base64: string | false): string {
  if (!base64 || typeof base64 !== 'string') return '';
  // Use first 200 + last 200 chars to avoid hashing huge strings
  const sample = base64.length > 400
    ? base64.slice(0, 200) + base64.slice(-200)
    : base64;
  return crypto.createHash('md5').update(sample).digest('hex').slice(0, 12);
}

// ─── Sync Progress ─────────────────────────────────────────────

export interface SyncProgress {
  current: number;
  total: number;
  phase: string;
  startedAt: string | null;
  estimatedSecondsLeft: number | null;
}

export interface SyncStatus {
  lastProductSync: string | null;
  lastStockSync: string | null;
  productsSynced: number;
  isRunning: boolean;
  lastError: string | null;
  progress: SyncProgress | null;
}

let syncStatus: SyncStatus = {
  lastProductSync: null,
  lastStockSync: null,
  productsSynced: 0,
  isRunning: false,
  lastError: null,
  progress: null,
};

let productSyncRunning = false;
let stockSyncRunning = false;

export function getSyncStatus(): SyncStatus {
  return { ...syncStatus };
}

// ─── Product Sync (Optimized) ──────────────────────────────────

function buildSellibriPayload(
  product: odoo.OdooProduct,
  mainImage: string | null,
  extraImages: odoo.ProductImage[],
  includeImages: boolean,
): sellibri.SellibriProductPayload {
  const price = (product.list_price * (1 + config.ivaRate)).toFixed(2);
  const description = product.website_description || product.description_sale || '';
  const categId = Array.isArray(product.categ_id) ? product.categ_id[0] : 0;
  const taxonId = mapCategory(categId);

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

  // Only include images if they changed (or on create)
  if (includeImages) {
    const images: { image: string }[] = [];
    if (mainImage) {
      images.push({ image: mainImage });
    }
    for (const img of extraImages) {
      if (img.image_1920 && typeof img.image_1920 === 'string') {
        images.push({ image: img.image_1920 });
      }
    }
    if (images.length > 0) {
      variant.images = images;
    }
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
  let skipped = 0;
  let errors = 0;
  const syncStartTime = Date.now();

  try {
    // ── Phase 1: Pre-load Sellibri catalog ──
    syncStatus.progress = {
      current: 0, total: 0,
      phase: 'Cargando catálogo Sellibri...',
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };
    logger.info(MODULE, 'Phase 1: Loading Sellibri catalog...');
    const sellibriCatalog = await sellibri.fetchAllProducts();
    logger.info(MODULE, `Sellibri catalog loaded: ${sellibriCatalog.size} SKUs`);

    // Merge with persisted state (in case Sellibri had products we didn't know about)
    for (const [sku, product] of sellibriCatalog) {
      if (!state.products[sku]) {
        const variant = product.all_variants?.[0];
        if (variant) {
          state.products[sku] = {
            sellibriId: product.id,
            sellibriVariantId: variant.id,
            odooWriteDate: '',
            lastSynced: '',
          };
        }
      }
    }

    // ── Phase 2: Fetch changed products from Odoo ──
    syncStatus.progress.phase = 'Obteniendo productos de Odoo...';
    logger.info(MODULE, 'Phase 2: Fetching products from Odoo...');
    const lastWrite = state.lastProductWriteDate || undefined;
    const products = await odoo.fetchAllProducts(lastWrite);
    logger.info(MODULE, `Odoo returned ${products.length} products to sync`);

    if (products.length === 0) {
      logger.info(MODULE, 'No products changed since last sync');
      state.lastProductSync = new Date().toISOString();
      saveState(state);
      syncStatus.lastProductSync = state.lastProductSync;
      syncStatus.productsSynced = Object.keys(state.products).length;
      return;
    }

    // ── Phase 3: Sync products in batches ──
    const total = products.length;
    syncStatus.progress = {
      current: 0, total,
      phase: `Sincronizando 0 / ${total} productos...`,
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };

    let maxWriteDate = state.lastProductWriteDate || '';
    const batchStartTime = Date.now();

    // Build tasks for batch processing
    const tasks: (() => Promise<void>)[] = products.map((product, idx) => async () => {
      const sku = product.default_code;
      if (!sku) return;

      // Check if product changed since last sync
      const cached = state.products[sku];
      if (cached && cached.odooWriteDate === product.write_date) {
        skipped++;
        return;
      }

      try {
        // Fetch main image individually (avoids OOM from bulk loading all images)
        const needsImages = !cached; // Always fetch images for new products
        let mainImage: string | null = null;
        let currentImgHash = '';
        let imagesChanged = false;

        if (needsImages || !cached?.imageHash) {
          // New product or never had images — always fetch
          mainImage = await odoo.fetchProductMainImage(product.id);
          currentImgHash = imageHash(mainImage || false);
          imagesChanged = true;
        } else {
          // Existing product — fetch image to check if it changed
          mainImage = await odoo.fetchProductMainImage(product.id);
          currentImgHash = imageHash(mainImage || false);
          imagesChanged = cached.imageHash !== currentImgHash;
          // Release image from memory if unchanged (we won't need it)
          if (!imagesChanged) {
            mainImage = null;
          }
        }

        // Fetch extra images only if images changed and product has them
        let extraImages: odoo.ProductImage[] = [];
        if (imagesChanged && product.product_template_image_ids?.length > 0) {
          extraImages = await odoo.fetchProductImages(product.product_template_image_ids);
        }

        const payload = buildSellibriPayload(product, mainImage, extraImages, imagesChanged || !cached);

        // Look up in pre-loaded catalog or state
        const existing = cached?.sellibriId
          ? cached
          : sellibriCatalog.has(sku)
            ? {
                sellibriId: sellibriCatalog.get(sku)!.id,
                sellibriVariantId: sellibriCatalog.get(sku)!.all_variants?.[0]?.id || 0,
              }
            : null;

        let sellibriId: number;
        let variantId: number;

        if (existing) {
          sellibriId = existing.sellibriId;
          variantId = existing.sellibriVariantId;
          // For updates, set variant id so Sellibri updates instead of creating new
          if (variantId && payload.product.all_variants[0]) {
            payload.product.all_variants[0].id = variantId;
          }
          await sellibri.updateProduct(sellibriId, payload);
        } else {
          const created = await sellibri.createProduct(payload);
          sellibriId = created.id;
          variantId = created.all_variants?.[0]?.id || 0;
        }

        state.products[sku] = {
          sellibriId,
          sellibriVariantId: variantId,
          odooWriteDate: product.write_date,
          lastSynced: new Date().toISOString(),
          imageHash: currentImgHash,
          lastStock: Math.max(0, Math.floor(product.qty_available || 0)),
        };
        synced++;

        if (product.write_date > maxWriteDate) {
          maxWriteDate = product.write_date;
        }
      } catch (err: any) {
        errors++;
        logger.error(MODULE, `Error SKU=${sku}: ${err.message}`);
      }

      // Update progress
      const done = synced + skipped + errors;
      const elapsed = (Date.now() - batchStartTime) / 1000;
      const rate = done > 0 ? elapsed / done : 1;
      const remaining = Math.max(0, total - done);
      syncStatus.progress = {
        current: done,
        total,
        phase: `Sincronizando ${done} / ${total} productos...`,
        startedAt: syncStatus.progress?.startedAt || new Date().toISOString(),
        estimatedSecondsLeft: Math.round(remaining * rate),
      };

      // Save state every 100 products
      if (done % 100 === 0) {
        saveState(state);
        logger.info(MODULE, `Progress: ${done}/${total} (synced=${synced}, skipped=${skipped}, errors=${errors})`);
      }
    });

    // Execute with concurrency of 3 (rate limiter handles the actual throttling)
    await sellibri.batchExecute(tasks, 3);

    if (maxWriteDate) {
      state.lastProductWriteDate = maxWriteDate;
    }
    state.lastProductSync = new Date().toISOString();
    saveState(state);

    syncStatus.lastProductSync = state.lastProductSync;
    syncStatus.productsSynced = Object.keys(state.products).length;

    const totalTime = ((Date.now() - syncStartTime) / 1000).toFixed(1);
    logger.info(MODULE, `Product sync complete in ${totalTime}s: ${synced} synced, ${skipped} skipped, ${errors} errors`);
  } catch (err: any) {
    syncStatus.lastError = err.message;
    logger.error(MODULE, `Product sync failed: ${err.message}`);
  } finally {
    productSyncRunning = false;
    syncStatus.isRunning = stockSyncRunning;
    syncStatus.progress = null;
  }
}

// ─── Stock Sync (Lightweight) ──────────────────────────────────

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
  let skipped = 0;
  let errors = 0;

  try {
    const trackedSkus = Object.keys(state.products);
    if (trackedSkus.length === 0) {
      logger.info(MODULE, 'No products tracked yet, skipping stock sync');
      return;
    }

    logger.info(MODULE, `Starting stock sync for ${trackedSkus.length} tracked products`);

    syncStatus.progress = {
      current: 0, total: trackedSkus.length,
      phase: 'Obteniendo stock de Odoo...',
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };

    // Fetch only stock-relevant fields from Odoo (lightweight, no images)
    const products = await odoo.fetchStockOnly();

    // Build SKU → qty map
    const odooStockMap = new Map<string, number>();
    for (const p of products) {
      if (p.default_code) {
        odooStockMap.set(p.default_code, Math.max(0, Math.floor(p.qty_available || 0)));
      }
    }

    logger.info(MODULE, `Odoo stock fetched: ${odooStockMap.size} products`);

    // Find products whose stock changed
    const tasks: (() => Promise<void>)[] = [];

    for (const sku of trackedSkus) {
      const cached = state.products[sku];
      if (!cached?.sellibriVariantId) continue;

      const currentStock = odooStockMap.get(sku);
      if (currentStock === undefined) continue;

      // Skip if stock hasn't changed
      if (cached.lastStock !== undefined && cached.lastStock === currentStock) {
        skipped++;
        continue;
      }

      tasks.push(async () => {
        try {
          await sellibri.updateVariantStock(
            cached.sellibriVariantId,
            config.sellibri.stockLocationId,
            currentStock,
          );
          state.products[sku].lastStock = currentStock;
          synced++;
        } catch (err: any) {
          errors++;
          logger.error(MODULE, `Stock error SKU=${sku}: ${err.message}`);
        }
      });
    }

    if (tasks.length === 0) {
      logger.info(MODULE, `No stock changes detected (${skipped} unchanged)`);
    } else {
      logger.info(MODULE, `${tasks.length} products need stock update, ${skipped} unchanged`);

      syncStatus.progress = {
        current: 0, total: tasks.length,
        phase: `Actualizando stock: 0 / ${tasks.length}...`,
        startedAt: new Date().toISOString(),
        estimatedSecondsLeft: null,
      };

      // Execute with concurrency of 3
      await sellibri.batchExecute(tasks, 3);
    }

    state.lastStockSync = new Date().toISOString();
    saveState(state);

    syncStatus.lastStockSync = state.lastStockSync;
    logger.info(MODULE, `Stock sync complete: ${synced} updated, ${skipped} unchanged, ${errors} errors`);
  } catch (err: any) {
    syncStatus.lastError = err.message;
    logger.error(MODULE, `Stock sync failed: ${err.message}`);
  } finally {
    stockSyncRunning = false;
    syncStatus.isRunning = productSyncRunning;
    syncStatus.progress = null;
  }
}
