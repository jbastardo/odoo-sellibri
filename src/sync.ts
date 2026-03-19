import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as odoo from './odoo';
import * as sellibri from './sellibri';
import { config } from './config';
import { mapCategory } from './category-map';
import { mapBrandToVendor } from './brand-map';
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
  lastPrice?: string;
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
function imageHash(base64: string | false | null): string {
  if (!base64 || typeof base64 !== 'string') return '';
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

// ─── Helpers ───────────────────────────────────────────────────

function isEmpty(val: any): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string' && val.trim() === '') return true;
  if (val === '0' || val === '0.0' || val === '0.00') return true;
  return false;
}

/** Get the Sellibri price from Odoo: use price_with_tax directly */
function getSellibriPrice(product: odoo.OdooProduct): string {
  const pwt = product.price_with_tax;
  if (pwt && pwt > 0) return pwt.toFixed(2);
  // Fallback: calculate manually if price_with_tax not available
  return (product.list_price * (1 + config.ivaRate)).toFixed(2);
}

function updateProgress(done: number, total: number, batchStartTime: number): void {
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
}

// ─── Smart Product Sync (fill empty fields only) ────────────────

/**
 * Build a PARTIAL update payload: only include fields that are empty in Sellibri.
 * ALWAYS update price (price_with_tax from Odoo) and stock if different.
 * NEVER include images in normal sync.
 */
function buildSmartPayload(
  odooProduct: odoo.OdooProduct,
  sellibriProduct: sellibri.SellibriProduct,
): sellibri.SellibriProductPayload | null {
  const variant = sellibriProduct.all_variants?.[0];
  if (!variant) return null;

  const odooPrice = getSellibriPrice(odooProduct);
  const odooStock = Math.max(0, Math.floor(odooProduct.qty_available || 0));
  const odooDescription = odooProduct.website_description || odooProduct.description_sale || '';
  const categId = Array.isArray(odooProduct.categ_id) ? odooProduct.categ_id[0] : 0;
  const taxonId = mapCategory(categId);
  const vendorId = mapBrandToVendor(odooProduct.brand_id);

  let needsUpdate = false;
  const productFields: Record<string, any> = {};
  const variantFields: Record<string, any> = {
    id: variant.id,
    sku: odooProduct.default_code,
    track_inventory: true,
    tax_rate_id: config.sellibri.taxRateId,
  };

  // ALWAYS check price — update if different
  const currentPrice = parseFloat(variant.price || '0');
  const newPrice = parseFloat(odooPrice);
  if (Math.abs(currentPrice - newPrice) > 0.01) {
    variantFields.price = odooPrice;
    needsUpdate = true;
    logger.info(MODULE, `SKU=${odooProduct.default_code}: price ${currentPrice} → ${newPrice}`);
  }

  // ALWAYS check stock — update if different
  const currentStock = variant.stock_items?.[0]?.available ?? 0;
  if (currentStock !== odooStock) {
    variantFields.stock_items = [{
      stock_location_id: config.sellibri.stockLocationId,
      available: odooStock,
    }];
    needsUpdate = true;
  }

  // Title: only if empty in Sellibri
  if (isEmpty(sellibriProduct.title)) {
    productFields.title = odooProduct.name;
    needsUpdate = true;
  }

  // Description: only if empty in Sellibri
  if (isEmpty(sellibriProduct.description)) {
    if (typeof odooDescription === 'string' && odooDescription.trim()) {
      productFields.description = odooDescription;
      needsUpdate = true;
    }
  }

  // Category: only if not set in Sellibri
  if (!sellibriProduct.taxon_ids || sellibriProduct.taxon_ids.length === 0) {
    productFields.taxon_ids = [taxonId];
    needsUpdate = true;
  }

  // Brand/Vendor: only if not set in Sellibri
  if (!sellibriProduct.product_vendor_id && vendorId) {
    productFields.product_vendor_id = vendorId;
    needsUpdate = true;
  }

  // Barcode: only if empty
  if (isEmpty(variant.barcode) && odooProduct.barcode) {
    variantFields.barcode = odooProduct.barcode;
    needsUpdate = true;
  }

  // Weight: only if empty
  if (isEmpty(variant.weight) && odooProduct.weight) {
    variantFields.weight = odooProduct.weight;
    needsUpdate = true;
  }

  if (!needsUpdate) return null;

  return {
    product: {
      title: productFields.title || sellibriProduct.title,
      status: 'active',
      ...(productFields.description !== undefined ? { description: productFields.description } : {}),
      ...(productFields.product_vendor_id ? { product_vendor_id: productFields.product_vendor_id } : {}),
      all_variants: [variantFields as any],
      taxon_ids: productFields.taxon_ids || sellibriProduct.taxon_ids || [taxonId],
    },
  };
}

/**
 * Build a FULL payload for creating new products or force-updating a specific SKU.
 * Includes ALL fields + images. Uses price_with_tax from Odoo.
 */
function buildFullPayload(
  odooProduct: odoo.OdooProduct,
  mainImage: string | null,
  extraImages: odoo.ProductImage[],
  existingVariantId?: number,
): sellibri.SellibriProductPayload {
  const price = getSellibriPrice(odooProduct);
  const description = odooProduct.website_description || odooProduct.description_sale || '';
  const categId = Array.isArray(odooProduct.categ_id) ? odooProduct.categ_id[0] : 0;
  const taxonId = mapCategory(categId);
  const vendorId = mapBrandToVendor(odooProduct.brand_id);

  const variant: sellibri.SellibriVariant = {
    price,
    sku: odooProduct.default_code,
    barcode: odooProduct.barcode || undefined,
    weight: odooProduct.weight || undefined,
    width: null,
    height: null,
    length: null,
    track_inventory: true,
    tax_rate_id: config.sellibri.taxRateId,
    stock_items: [{
      stock_location_id: config.sellibri.stockLocationId,
      available: Math.max(0, Math.floor(odooProduct.qty_available || 0)),
    }],
  };

  if (existingVariantId) {
    variant.id = existingVariantId;
  }

  // Include images
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

  return {
    product: {
      title: odooProduct.name,
      status: 'active',
      description: typeof description === 'string' ? description : '',
      ...(vendorId ? { product_vendor_id: vendorId } : {}),
      all_variants: [variant],
      taxon_ids: [taxonId],
    },
  };
}

// ─── Product Sync (Smart: fill empty fields only) ──────────────

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
  let created = 0;
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

    // Merge with persisted state
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

    // ── Phase 2: Fetch products from Odoo ──
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

    // ── Phase 3: Smart sync ──
    const total = products.length;
    syncStatus.progress = {
      current: 0, total,
      phase: `Sincronizando 0 / ${total} productos...`,
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };

    let maxWriteDate = state.lastProductWriteDate || '';
    const batchStartTime = Date.now();

    const tasks: (() => Promise<void>)[] = products.map((product) => async () => {
      const sku = product.default_code;
      if (!sku) return;

      // Check if product changed since last sync
      const cached = state.products[sku];
      if (cached && cached.odooWriteDate === product.write_date) {
        skipped++;
        updateProgress(synced + created + skipped + errors, total, batchStartTime);
        return;
      }

      try {
        // Check if product exists in Sellibri
        const existingInCatalog = sellibriCatalog.get(sku);
        const existingInState = cached?.sellibriId ? cached : null;
        const existingSellibriId = existingInCatalog?.id || existingInState?.sellibriId;
        const existingVariantId = existingInCatalog?.all_variants?.[0]?.id || existingInState?.sellibriVariantId;

        let sellibriId: number;
        let variantId: number;

        if (existingSellibriId && existingVariantId) {
          // ── EXISTING: smart update (only empty fields + always price/qty) ──
          const sellibriProduct = existingInCatalog || await sellibri.fetchProductById(existingSellibriId);
          if (!sellibriProduct) {
            logger.warn(MODULE, `SKU=${sku}: Sellibri product ${existingSellibriId} not found, skipping`);
            skipped++;
            updateProgress(synced + created + skipped + errors, total, batchStartTime);
            return;
          }

          const payload = buildSmartPayload(product, sellibriProduct);
          if (payload) {
            await sellibri.updateProduct(existingSellibriId, payload);
            synced++;
          } else {
            skipped++;
          }

          sellibriId = existingSellibriId;
          variantId = existingVariantId;
        } else {
          // ── NEW: create with all fields + images ──
          const mainImage = await odoo.fetchProductMainImage(product.id);
          let extraImages: odoo.ProductImage[] = [];
          if (product.product_template_image_ids?.length > 0) {
            extraImages = await odoo.fetchProductImages(product.product_template_image_ids);
          }

          const payload = buildFullPayload(product, mainImage, extraImages);
          const newProduct = await sellibri.createProduct(payload);
          sellibriId = newProduct.id;
          variantId = newProduct.all_variants?.[0]?.id || 0;
          created++;
          logger.info(MODULE, `Created SKU=${sku} in Sellibri (id=${sellibriId})`);
        }

        const odooPrice = getSellibriPrice(product);
        state.products[sku] = {
          sellibriId,
          sellibriVariantId: variantId,
          odooWriteDate: product.write_date,
          lastSynced: new Date().toISOString(),
          lastStock: Math.max(0, Math.floor(product.qty_available || 0)),
          lastPrice: odooPrice,
        };

        if (product.write_date > maxWriteDate) {
          maxWriteDate = product.write_date;
        }
      } catch (err: any) {
        errors++;
        logger.error(MODULE, `Error SKU=${sku}: ${err.message}`);
      }

      updateProgress(synced + created + skipped + errors, total, batchStartTime);

      const done = synced + created + skipped + errors;
      if (done % 100 === 0) {
        saveState(state);
        logger.info(MODULE, `Progress: ${done}/${total} (created=${created}, updated=${synced}, skipped=${skipped}, errors=${errors})`);
      }
    });

    await sellibri.batchExecute(tasks, 3);

    if (maxWriteDate) {
      state.lastProductWriteDate = maxWriteDate;
    }
    state.lastProductSync = new Date().toISOString();
    saveState(state);

    syncStatus.lastProductSync = state.lastProductSync;
    syncStatus.productsSynced = Object.keys(state.products).length;

    const totalTime = ((Date.now() - syncStartTime) / 1000).toFixed(1);
    logger.info(MODULE, `Product sync complete in ${totalTime}s: ${created} created, ${synced} updated, ${skipped} skipped, ${errors} errors`);
  } catch (err: any) {
    syncStatus.lastError = err.message;
    logger.error(MODULE, `Product sync failed: ${err.message}`);
  } finally {
    productSyncRunning = false;
    syncStatus.isRunning = stockSyncRunning;
    syncStatus.progress = null;
  }
}

// ─── Force Sync Single SKU (all fields + images) ──────────────

export async function syncSingleSku(sku: string): Promise<{ success: boolean; message: string }> {
  logger.info(MODULE, `Force sync SKU=${sku}...`);

  try {
    const odooProduct = await odoo.fetchProductBySku(sku);

    if (!odooProduct) {
      return { success: false, message: `SKU ${sku} no encontrado en Odoo` };
    }

    // Fetch image from Odoo
    const mainImage = await odoo.fetchProductMainImage(odooProduct.id);
    let extraImages: odoo.ProductImage[] = [];
    if (odooProduct.product_template_image_ids?.length > 0) {
      extraImages = await odoo.fetchProductImages(odooProduct.product_template_image_ids);
    }

    // Check if exists in Sellibri
    const state = loadState();
    const cached = state.products[sku];
    let existingProduct: sellibri.SellibriProduct | null = null;

    if (cached?.sellibriId) {
      existingProduct = await sellibri.fetchProductById(cached.sellibriId);
    }
    if (!existingProduct) {
      existingProduct = await sellibri.findProductBySku(sku);
    }

    let sellibriId: number;
    let variantId: number;

    if (existingProduct) {
      const existingVariantId = existingProduct.all_variants?.[0]?.id;
      const payload = buildFullPayload(odooProduct, mainImage, extraImages, existingVariantId);
      await sellibri.updateProduct(existingProduct.id, payload);
      sellibriId = existingProduct.id;
      variantId = existingVariantId || 0;
      logger.info(MODULE, `Force-updated SKU=${sku} in Sellibri (id=${sellibriId})`);
    } else {
      const payload = buildFullPayload(odooProduct, mainImage, extraImages);
      const newProduct = await sellibri.createProduct(payload);
      sellibriId = newProduct.id;
      variantId = newProduct.all_variants?.[0]?.id || 0;
      logger.info(MODULE, `Force-created SKU=${sku} in Sellibri (id=${sellibriId})`);
    }

    const odooPrice = getSellibriPrice(odooProduct);
    state.products[sku] = {
      sellibriId,
      sellibriVariantId: variantId,
      odooWriteDate: odooProduct.write_date,
      lastSynced: new Date().toISOString(),
      imageHash: imageHash(mainImage),
      lastStock: Math.max(0, Math.floor(odooProduct.qty_available || 0)),
      lastPrice: odooPrice,
    };
    saveState(state);

    return {
      success: true,
      message: existingProduct
        ? `SKU ${sku} actualizado (todos los campos + fotos)`
        : `SKU ${sku} creado en Sellibri`,
    };
  } catch (err: any) {
    logger.error(MODULE, `Force sync SKU=${sku} failed: ${err.message}`);
    return { success: false, message: err.message };
  }
}

// ─── Sync Photos (only for products without images) ────────────

export async function syncPhotos(): Promise<void> {
  if (productSyncRunning) {
    logger.warn(MODULE, 'Cannot sync photos while product sync is running');
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
    syncStatus.progress = {
      current: 0, total: 0,
      phase: 'Verificando fotos en Sellibri...',
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };

    const trackedSkus = Object.keys(state.products);
    if (trackedSkus.length === 0) {
      logger.info(MODULE, 'No tracked products, skipping photo sync');
      return;
    }

    logger.info(MODULE, `Photo sync: checking ${trackedSkus.length} tracked products`);

    const sellibriCatalog = await sellibri.fetchAllProducts();

    // Find products without images
    const needsPhotos: { sku: string; sellibriId: number; variantId: number }[] = [];

    for (const sku of trackedSkus) {
      const cached = state.products[sku];
      if (!cached?.sellibriId) continue;

      const sellibriProduct = sellibriCatalog.get(sku);
      if (!sellibriProduct) continue;

      const variant = sellibriProduct.all_variants?.[0];
      if (!variant) continue;

      const hasImages = variant.images && variant.images.length > 0;
      if (!hasImages) {
        needsPhotos.push({
          sku,
          sellibriId: cached.sellibriId,
          variantId: cached.sellibriVariantId,
        });
      }
    }

    logger.info(MODULE, `Found ${needsPhotos.length} products without photos out of ${trackedSkus.length} tracked`);

    if (needsPhotos.length === 0) {
      logger.info(MODULE, 'All products already have photos');
      return;
    }

    const total = needsPhotos.length;
    syncStatus.progress = {
      current: 0, total,
      phase: `Subiendo fotos: 0 / ${total}...`,
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };

    // Load all Odoo products to get IDs for image fetch
    const allOdooProducts = await odoo.fetchAllProducts();
    const odooBysku = new Map<string, odoo.OdooProduct>();
    for (const p of allOdooProducts) {
      if (p.default_code) odooBysku.set(p.default_code, p);
    }

    const batchStartTime = Date.now();

    const tasks: (() => Promise<void>)[] = needsPhotos.map((item) => async () => {
      try {
        const odooProduct = odooBysku.get(item.sku);
        if (!odooProduct) {
          skipped++;
          return;
        }

        const mainImage = await odoo.fetchProductMainImage(odooProduct.id);
        if (!mainImage) {
          skipped++;
          logger.info(MODULE, `SKU=${item.sku}: no image in Odoo, skipping`);
          return;
        }

        let extraImages: odoo.ProductImage[] = [];
        if (odooProduct.product_template_image_ids?.length > 0) {
          extraImages = await odoo.fetchProductImages(odooProduct.product_template_image_ids);
        }

        const images: { image: string }[] = [{ image: mainImage }];
        for (const img of extraImages) {
          if (img.image_1920 && typeof img.image_1920 === 'string') {
            images.push({ image: img.image_1920 });
          }
        }

        // Preserve existing product data while adding images
        const currentProduct = sellibriCatalog.get(item.sku);
        const currentVariant = currentProduct?.all_variants?.[0];
        await sellibri.updateProduct(item.sellibriId, {
          product: {
            title: currentProduct?.title || odooProduct.name,
            all_variants: [{
              id: item.variantId,
              sku: item.sku,
              price: currentVariant?.price || getSellibriPrice(odooProduct),
              track_inventory: true,
              tax_rate_id: config.sellibri.taxRateId,
              images,
            }],
            taxon_ids: currentProduct?.taxon_ids || [],
          },
        });

        state.products[item.sku].imageHash = imageHash(mainImage);
        synced++;
        logger.info(MODULE, `Uploaded ${images.length} photo(s) for SKU=${item.sku}`);
      } catch (err: any) {
        errors++;
        logger.error(MODULE, `Photo error SKU=${item.sku}: ${err.message}`);
      }

      const done = synced + skipped + errors;
      const elapsed = (Date.now() - batchStartTime) / 1000;
      const rate = done > 0 ? elapsed / done : 1;
      const remaining = Math.max(0, total - done);
      syncStatus.progress = {
        current: done,
        total,
        phase: `Subiendo fotos: ${done} / ${total}...`,
        startedAt: syncStatus.progress?.startedAt || new Date().toISOString(),
        estimatedSecondsLeft: Math.round(remaining * rate),
      };

      if (done % 50 === 0) {
        saveState(state);
        logger.info(MODULE, `Photo progress: ${done}/${total} (synced=${synced}, skipped=${skipped}, errors=${errors})`);
      }
    });

    await sellibri.batchExecute(tasks, 2);
    saveState(state);

    const totalTime = ((Date.now() - syncStartTime) / 1000).toFixed(1);
    logger.info(MODULE, `Photo sync complete in ${totalTime}s: ${synced} uploaded, ${skipped} skipped, ${errors} errors`);
  } catch (err: any) {
    syncStatus.lastError = err.message;
    logger.error(MODULE, `Photo sync failed: ${err.message}`);
  } finally {
    productSyncRunning = false;
    syncStatus.isRunning = stockSyncRunning;
    syncStatus.progress = null;
  }
}

// ─── Precio/Stock Sync (price_with_tax + qty_available) ────────

export async function syncPriceStock(): Promise<void> {
  if (stockSyncRunning) {
    logger.warn(MODULE, 'Price/Stock sync already running, skipping');
    return;
  }
  stockSyncRunning = true;
  syncStatus.isRunning = true;
  syncStatus.lastError = null;

  const state = loadState();
  let priceUpdated = 0;
  let stockUpdated = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const trackedSkus = Object.keys(state.products);
    if (trackedSkus.length === 0) {
      logger.info(MODULE, 'No products tracked yet, skipping price/stock sync');
      return;
    }

    logger.info(MODULE, `Starting price/stock sync for ${trackedSkus.length} tracked products`);

    syncStatus.progress = {
      current: 0, total: trackedSkus.length,
      phase: 'Obteniendo precio/stock de Odoo...',
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };

    // Fetch stock + price from Odoo (lightweight, no images)
    const products = await odoo.fetchStockAndPrices();

    // Build SKU → { qty, price } map
    const odooDataMap = new Map<string, { qty: number; price: string }>();
    for (const p of products) {
      if (p.default_code) {
        odooDataMap.set(p.default_code, {
          qty: Math.max(0, Math.floor(p.qty_available || 0)),
          price: p.price_with_tax > 0 ? p.price_with_tax.toFixed(2) : '0.00',
        });
      }
    }

    logger.info(MODULE, `Odoo price/stock fetched: ${odooDataMap.size} products`);

    const tasks: (() => Promise<void>)[] = [];

    for (const sku of trackedSkus) {
      const cached = state.products[sku];
      if (!cached?.sellibriVariantId) continue;

      const odooData = odooDataMap.get(sku);
      if (!odooData) continue;

      const stockChanged = cached.lastStock === undefined || cached.lastStock !== odooData.qty;
      const priceChanged = !cached.lastPrice || cached.lastPrice !== odooData.price;

      if (!stockChanged && !priceChanged) {
        skipped++;
        continue;
      }

      tasks.push(async () => {
        try {
          // Build variant update with both price and stock
          const variantUpdate: any = {
            variant: {},
          };

          if (priceChanged) {
            variantUpdate.variant.price = odooData.price;
          }

          if (stockChanged) {
            variantUpdate.variant.stock_items = [{
              stock_location_id: config.sellibri.stockLocationId,
              available: odooData.qty,
            }];
          }

          // Use updateProduct to update the variant's price+stock together
          await sellibri.updateProduct(cached.sellibriId, {
            product: {
              title: '', // Will be ignored on PATCH
              all_variants: [{
                id: cached.sellibriVariantId,
                sku,
                price: odooData.price,
                track_inventory: true,
                tax_rate_id: config.sellibri.taxRateId,
                stock_items: [{
                  stock_location_id: config.sellibri.stockLocationId,
                  available: odooData.qty,
                }],
              }],
              taxon_ids: [],
            },
          });

          if (priceChanged) priceUpdated++;
          if (stockChanged) stockUpdated++;

          state.products[sku].lastStock = odooData.qty;
          state.products[sku].lastPrice = odooData.price;
        } catch (err: any) {
          errors++;
          logger.error(MODULE, `Price/Stock error SKU=${sku}: ${err.message}`);
        }
      });
    }

    if (tasks.length === 0) {
      logger.info(MODULE, `No price/stock changes detected (${skipped} unchanged)`);
    } else {
      logger.info(MODULE, `${tasks.length} products need price/stock update, ${skipped} unchanged`);

      syncStatus.progress = {
        current: 0, total: tasks.length,
        phase: `Actualizando precio/stock: 0 / ${tasks.length}...`,
        startedAt: new Date().toISOString(),
        estimatedSecondsLeft: null,
      };

      await sellibri.batchExecute(tasks, 3);
    }

    state.lastStockSync = new Date().toISOString();
    saveState(state);

    syncStatus.lastStockSync = state.lastStockSync;
    logger.info(MODULE, `Price/Stock sync complete: ${priceUpdated} prices updated, ${stockUpdated} stock updated, ${skipped} unchanged, ${errors} errors`);
  } catch (err: any) {
    syncStatus.lastError = err.message;
    logger.error(MODULE, `Price/Stock sync failed: ${err.message}`);
  } finally {
    stockSyncRunning = false;
    syncStatus.isRunning = productSyncRunning;
    syncStatus.progress = null;
  }
}
