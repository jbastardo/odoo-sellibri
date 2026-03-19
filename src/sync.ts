import * as fs from 'fs';
import * as path from 'path';
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
let abortRequested = false;

export function getSyncStatus(): SyncStatus {
  return { ...syncStatus };
}

export function requestAbort(): boolean {
  if (!syncStatus.isRunning) return false;
  abortRequested = true;
  logger.warn(MODULE, 'Abort requested — sync will stop after current product');
  return true;
}

export function resetSyncState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
    syncStatus.productsSynced = 0;
    syncStatus.lastProductSync = null;
    syncStatus.lastStockSync = null;
    logger.warn(MODULE, 'Sync state cleared — next sync will start from scratch');
  } catch (err: any) {
    logger.error(MODULE, `Could not clear sync state: ${err.message}`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function isEmpty(val: any): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string' && val.trim() === '') return true;
  if (val === '0' || val === '0.0' || val === '0.00') return true;
  return false;
}

function getSellibriPrice(product: odoo.OdooProduct): string {
  const pwt = product.price_with_tax;
  if (pwt && pwt > 0) return pwt.toFixed(2);
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

/** Validate that a product has minimum required data for Sellibri */
function isValidForSellibri(product: odoo.OdooProduct): boolean {
  // Must have a title
  if (!product.name || product.name.trim() === '') return false;
  // Must have a price > 0
  const price = parseFloat(getSellibriPrice(product));
  if (isNaN(price) || price <= 0) return false;
  return true;
}

// ─── Smart Product Sync ────────────────────────────────────────

/**
 * Build a PARTIAL update payload.
 * KEY FIX: ALWAYS set status='active' if product has price > 0 (even if currently 'draft').
 * Fill empty fields only. Always update price/stock if different.
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
  const masterAttrs: sellibri.SellibriMasterAttributes = {
    sku: odooProduct.default_code,
    track_inventory: true,
    tax_rate_id: config.sellibri.taxRateId,
  };

  // FIX: If product is hidden (draft) but should be visible → force active
  if (sellibriProduct.status !== 'active') {
    needsUpdate = true;
  }

  // ALWAYS check price — update if different
  const currentPrice = parseFloat(variant.price || '0');
  const newPrice = parseFloat(odooPrice);
  if (Math.abs(currentPrice - newPrice) > 0.01) {
    masterAttrs.price = odooPrice;
    needsUpdate = true;
  }

  // ALWAYS check stock — update if different
  const currentStock = variant.stock_items?.[0]?.available ?? 0;
  if (currentStock !== odooStock) {
    masterAttrs.stock_items_attributes = [{
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

  // Category: only if not set
  if (!sellibriProduct.taxon_ids || sellibriProduct.taxon_ids.length === 0) {
    productFields.taxon_ids = [taxonId];
    needsUpdate = true;
  }

  // Brand/Vendor: only if not set
  if (!sellibriProduct.product_vendor_id && vendorId) {
    productFields.product_vendor_id = vendorId;
    needsUpdate = true;
  }

  // Barcode: only if empty
  if (isEmpty(variant.barcode) && odooProduct.barcode) {
    masterAttrs.barcode = odooProduct.barcode;
    needsUpdate = true;
  }

  // Weight: only if empty
  if (isEmpty(variant.weight) && odooProduct.weight) {
    masterAttrs.weight = odooProduct.weight;
    needsUpdate = true;
  }

  if (!needsUpdate) return null;

  return {
    product: {
      title: productFields.title || sellibriProduct.title || odooProduct.name,
      status: 'active', // ALWAYS set active for synced products
      ...(productFields.description !== undefined ? { description: productFields.description } : {}),
      ...(productFields.product_vendor_id ? { product_vendor_id: productFields.product_vendor_id } : {}),
      master_attributes: masterAttrs,
      taxon_ids: productFields.taxon_ids || sellibriProduct.taxon_ids || [taxonId],
    },
  };
}

/**
 * Build a FULL payload for creating new products.
 * Validates that product has required fields before creating.
 */
function buildFullPayload(
  odooProduct: odoo.OdooProduct,
): sellibri.SellibriProductPayload {
  const price = getSellibriPrice(odooProduct);
  const description = odooProduct.website_description || odooProduct.description_sale || '';
  const categId = Array.isArray(odooProduct.categ_id) ? odooProduct.categ_id[0] : 0;
  const taxonId = mapCategory(categId);
  const vendorId = mapBrandToVendor(odooProduct.brand_id);

  const masterAttrs: sellibri.SellibriMasterAttributes = {
    sku: odooProduct.default_code,
    price,
    barcode: odooProduct.barcode || undefined,
    weight: odooProduct.weight || undefined,
    width: null,
    height: null,
    length: null,
    track_inventory: true,
    tax_rate_id: config.sellibri.taxRateId,
    stock_items_attributes: [{
      stock_location_id: config.sellibri.stockLocationId,
      available: Math.max(0, Math.floor(odooProduct.qty_available || 0)),
    }],
  };

  return {
    product: {
      title: odooProduct.name,
      status: 'active',
      description: typeof description === 'string' ? description : '',
      ...(vendorId ? { product_vendor_id: vendorId } : {}),
      master_attributes: masterAttrs,
      taxon_ids: [taxonId],
    },
  };
}

// ─── Product Sync (Sequential — no parallel workers) ───────────

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
  let activated = 0;
  let invalidSkipped = 0;
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

    // ── Phase 3: Sequential sync (one product at a time) ──
    const total = products.length;
    syncStatus.progress = {
      current: 0, total,
      phase: `Sincronizando 0 / ${total} productos...`,
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };

    let maxWriteDate = state.lastProductWriteDate || '';
    const batchStartTime = Date.now();

    for (let i = 0; i < products.length; i++) {
      if (abortRequested) break;

      const product = products[i];
      const sku = product.default_code;
      if (!sku) continue;

      // Skip if product hasn't changed since last sync
      const cached = state.products[sku];
      if (cached && cached.odooWriteDate === product.write_date) {
        skipped++;
        updateProgress(synced + created + skipped + errors + invalidSkipped, total, batchStartTime);
        continue;
      }

      // Validate product data before sending to Sellibri
      if (!isValidForSellibri(product)) {
        invalidSkipped++;
        updateProgress(synced + created + skipped + errors + invalidSkipped, total, batchStartTime);
        continue;
      }

      try {
        // Look up in pre-loaded catalog + state (NO full-catalog scan per SKU)
        const existingInCatalog = sellibriCatalog.get(sku);
        const existingInState = cached?.sellibriId ? cached : null;
        const existingSellibriId = existingInCatalog?.id || existingInState?.sellibriId;
        const existingVariantId = existingInCatalog?.all_variants?.[0]?.id || existingInState?.sellibriVariantId;

        let sellibriId: number;
        let variantId: number;

        if (existingSellibriId && existingVariantId) {
          // ── EXISTING: smart update ──
          const sellibriProduct = existingInCatalog || await sellibri.fetchProductById(existingSellibriId);
          if (!sellibriProduct) {
            skipped++;
            updateProgress(synced + created + skipped + errors + invalidSkipped, total, batchStartTime);
            continue;
          }

          // Track if we're activating a hidden product
          const wasDraft = sellibriProduct.status !== 'active';

          const payload = buildSmartPayload(product, sellibriProduct);
          if (payload) {
            await sellibri.updateProduct(existingSellibriId, payload);
            synced++;
            if (wasDraft) activated++;
          } else {
            skipped++;
          }

          sellibriId = existingSellibriId;
          variantId = existingVariantId;
        } else {
          // ── NEW: create in Sellibri ──
          const payload = buildFullPayload(product);
          const newProduct = await sellibri.createProduct(payload);
          sellibriId = newProduct.id;
          variantId = newProduct.all_variants?.[0]?.id || 0;
          created++;
          logger.info(MODULE, `Created SKU=${sku} (id=${sellibriId})`);
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
        const status = (err as any)?.response?.status;
        // Only log 400 errors at debug level — they're just bad data, not system issues
        if (status === 400) {
          logger.warn(MODULE, `SKU=${sku}: 400 Bad Request (invalid data, skipped)`);
        } else {
          logger.error(MODULE, `Error SKU=${sku}: ${err.message}`);
        }
      }

      const done = synced + created + skipped + errors + invalidSkipped;
      updateProgress(done, total, batchStartTime);

      if (done % 100 === 0) {
        saveState(state);
        logger.info(MODULE, `Progress: ${done}/${total} (updated=${synced}, created=${created}, activated=${activated}, skipped=${skipped}, invalid=${invalidSkipped}, errors=${errors})`);
      }
    }

    if (maxWriteDate) {
      state.lastProductWriteDate = maxWriteDate;
    }
    state.lastProductSync = new Date().toISOString();
    saveState(state);

    syncStatus.lastProductSync = state.lastProductSync;
    syncStatus.productsSynced = Object.keys(state.products).length;

    const totalTime = ((Date.now() - syncStartTime) / 1000 / 60).toFixed(1);
    const msg = `Product sync ${abortRequested ? 'ABORTED' : 'complete'} in ${totalTime}min: ${created} created, ${synced} updated, ${activated} activated, ${skipped} skipped, ${invalidSkipped} invalid, ${errors} errors`;
    logger.info(MODULE, msg);
  } catch (err: any) {
    syncStatus.lastError = err.message;
    logger.error(MODULE, `Product sync failed: ${err.message}`);
  } finally {
    productSyncRunning = false;
    abortRequested = false;
    syncStatus.isRunning = stockSyncRunning;
    syncStatus.progress = null;
  }
}

// ─── Force Sync Single SKU ─────────────────────────────────────

export async function syncSingleSku(sku: string): Promise<{ success: boolean; message: string }> {
  logger.info(MODULE, `Force sync SKU=${sku}...`);

  try {
    const odooProduct = await odoo.fetchProductBySku(sku);
    if (!odooProduct) {
      return { success: false, message: `SKU ${sku} no encontrado en Odoo` };
    }

    // Check local state first, then fetch by ID — no full catalog scan
    const state = loadState();
    const cached = state.products[sku];
    let existingProduct: sellibri.SellibriProduct | null = null;

    if (cached?.sellibriId) {
      existingProduct = await sellibri.fetchProductById(cached.sellibriId);
    }

    const payload = buildFullPayload(odooProduct);

    let sellibriId: number;
    let variantId: number;

    if (existingProduct) {
      await sellibri.updateProduct(existingProduct.id, payload);
      sellibriId = existingProduct.id;
      variantId = existingProduct.all_variants?.[0]?.id || 0;
      logger.info(MODULE, `Force-updated SKU=${sku} (id=${sellibriId})`);
    } else {
      const newProduct = await sellibri.createProduct(payload);
      sellibriId = newProduct.id;
      variantId = newProduct.all_variants?.[0]?.id || 0;
      logger.info(MODULE, `Force-created SKU=${sku} (id=${sellibriId})`);
    }

    const odooPrice = getSellibriPrice(odooProduct);
    state.products[sku] = {
      sellibriId,
      sellibriVariantId: variantId,
      odooWriteDate: odooProduct.write_date,
      lastSynced: new Date().toISOString(),
      lastStock: Math.max(0, Math.floor(odooProduct.qty_available || 0)),
      lastPrice: odooPrice,
    };
    saveState(state);

    return {
      success: true,
      message: existingProduct
        ? `SKU ${sku} actualizado y activado`
        : `SKU ${sku} creado en Sellibri`,
    };
  } catch (err: any) {
    logger.error(MODULE, `Force sync SKU=${sku} failed: ${err.message}`);
    return { success: false, message: err.message };
  }
}

// ─── Sync Photos (no-op) ───────────────────────────────────────

export async function syncPhotos(): Promise<void> {
  logger.warn(MODULE, 'Photo sync is disabled — Sellibri API does not support image uploads.');
}

// ─── Cleanup: Delete from Sellibri products not in Odoo ────────

let cleanupRunning = false;

export interface CleanupResult {
  totalSellibri: number;
  totalOdoo: number;
  deleted: number;
  failed: number;
  orphanSkus: string[];
}

export async function syncCleanup(): Promise<CleanupResult> {
  if (cleanupRunning || productSyncRunning || stockSyncRunning) {
    logger.warn(MODULE, 'Cleanup: another sync is running, skipping');
    return { totalSellibri: 0, totalOdoo: 0, deleted: 0, failed: 0, orphanSkus: [] };
  }
  cleanupRunning = true;
  syncStatus.isRunning = true;
  syncStatus.lastError = null;

  const result: CleanupResult = {
    totalSellibri: 0,
    totalOdoo: 0,
    deleted: 0,
    failed: 0,
    orphanSkus: [],
  };

  try {
    // Phase 1: Load Sellibri catalog
    syncStatus.progress = {
      current: 0, total: 0,
      phase: 'Limpieza: cargando catálogo Sellibri...',
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };
    logger.info(MODULE, 'Cleanup Phase 1: Loading Sellibri catalog...');
    const sellibriCatalog = await sellibri.fetchAllProducts();
    result.totalSellibri = sellibriCatalog.size;
    logger.info(MODULE, `Sellibri catalog: ${sellibriCatalog.size} SKUs`);

    // Phase 2: Load Odoo active SKUs
    syncStatus.progress.phase = 'Limpieza: cargando SKUs activos de Odoo...';
    logger.info(MODULE, 'Cleanup Phase 2: Loading Odoo active SKUs...');
    const odooSKUs = await odoo.fetchAllActiveSKUs();
    result.totalOdoo = odooSKUs.size;
    logger.info(MODULE, `Odoo active SKUs: ${odooSKUs.size}`);

    // Phase 3: Find orphans
    const orphans: { sku: string; sellibriId: number }[] = [];
    const seenIds = new Set<number>();

    for (const [sku, product] of sellibriCatalog) {
      if (!odooSKUs.has(sku) && !seenIds.has(product.id)) {
        orphans.push({ sku, sellibriId: product.id });
        seenIds.add(product.id);
        result.orphanSkus.push(sku);
      }
    }

    logger.info(MODULE, `Found ${orphans.length} orphan products to delete`);

    if (orphans.length === 0) {
      logger.info(MODULE, 'Cleanup: no orphans — catalogs are in sync');
      return result;
    }

    // Phase 4: Delete orphans sequentially
    const total = orphans.length;
    const batchStartTime = Date.now();
    syncStatus.progress = {
      current: 0, total,
      phase: `Limpieza: eliminando 0 / ${total} huérfanos...`,
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };

    const state = loadState();

    for (let i = 0; i < orphans.length; i++) {
      if (abortRequested) break;

      const orphan = orphans[i];
      try {
        const deleted = await sellibri.deleteProduct(orphan.sellibriId);
        if (deleted) {
          result.deleted++;
          delete state.products[orphan.sku];
        } else {
          result.failed++;
        }
      } catch (err: any) {
        result.failed++;
        logger.error(MODULE, `Cleanup: failed SKU=${orphan.sku} (id=${orphan.sellibriId}): ${err.message}`);
      }

      const done = result.deleted + result.failed;
      const elapsed = (Date.now() - batchStartTime) / 1000;
      const rate = done > 0 ? elapsed / done : 1;
      syncStatus.progress = {
        current: done,
        total,
        phase: `Limpieza: eliminando ${done} / ${total} huérfanos...`,
        startedAt: syncStatus.progress?.startedAt || new Date().toISOString(),
        estimatedSecondsLeft: Math.round((total - done) * rate),
      };

      if (done % 50 === 0) {
        saveState(state);
        logger.info(MODULE, `Cleanup: ${done}/${total} (deleted=${result.deleted}, failed=${result.failed})`);
      }
    }

    saveState(state);
    logger.info(MODULE, `Cleanup complete: ${result.deleted} deleted, ${result.failed} failed out of ${orphans.length} orphans`);
  } catch (err: any) {
    syncStatus.lastError = err.message;
    logger.error(MODULE, `Cleanup failed: ${err.message}`);
  } finally {
    cleanupRunning = false;
    abortRequested = false;
    syncStatus.isRunning = productSyncRunning || stockSyncRunning;
    syncStatus.progress = null;
  }

  return result;
}

// ─── Precio/Stock Sync ─────────────────────────────────────────

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

    const products = await odoo.fetchStockAndPrices();

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

    // Build list of products that need updating
    const toUpdate: { sku: string; cached: ProductSyncEntry; odooData: { qty: number; price: string } }[] = [];

    for (const sku of trackedSkus) {
      const cached = state.products[sku];
      if (!cached?.sellibriId) continue;

      const odooData = odooDataMap.get(sku);
      if (!odooData) continue;

      const stockChanged = cached.lastStock === undefined || cached.lastStock !== odooData.qty;
      const priceChanged = !cached.lastPrice || cached.lastPrice !== odooData.price;

      if (!stockChanged && !priceChanged) {
        skipped++;
        continue;
      }

      toUpdate.push({ sku, cached, odooData });
    }

    if (toUpdate.length === 0) {
      logger.info(MODULE, `No price/stock changes detected (${skipped} unchanged)`);
    } else {
      logger.info(MODULE, `${toUpdate.length} products need price/stock update, ${skipped} unchanged`);

      syncStatus.progress = {
        current: 0, total: toUpdate.length,
        phase: `Actualizando precio/stock: 0 / ${toUpdate.length}...`,
        startedAt: new Date().toISOString(),
        estimatedSecondsLeft: null,
      };

      // Sequential update — one at a time
      for (let i = 0; i < toUpdate.length; i++) {
        if (abortRequested) break;

        const { sku, cached, odooData } = toUpdate[i];
        try {
          const masterAttrs: sellibri.SellibriMasterAttributes = {
            sku,
            price: odooData.price,
            track_inventory: true,
            tax_rate_id: config.sellibri.taxRateId,
            stock_items_attributes: [{
              stock_location_id: config.sellibri.stockLocationId,
              available: odooData.qty,
            }],
          };

          await sellibri.updateProduct(cached.sellibriId, {
            product: {
              status: 'active',
              master_attributes: masterAttrs,
            },
          });

          const stockChanged = cached.lastStock === undefined || cached.lastStock !== odooData.qty;
          const priceChanged = !cached.lastPrice || cached.lastPrice !== odooData.price;
          if (priceChanged) priceUpdated++;
          if (stockChanged) stockUpdated++;

          state.products[sku].lastStock = odooData.qty;
          state.products[sku].lastPrice = odooData.price;
        } catch (err: any) {
          errors++;
          logger.error(MODULE, `Price/Stock error SKU=${sku}: ${err.message}`);
        }

        if ((i + 1) % 100 === 0) {
          saveState(state);
          const startedAtStr: string = syncStatus.progress?.startedAt || new Date().toISOString();
          const elapsedMs: number = Date.now() - Date.parse(startedAtStr);
          const elapsedSec: number = elapsedMs / 1000;
          const ratePerItem: number = (i + 1) > 0 ? elapsedSec / (i + 1) : 1;
          syncStatus.progress = {
            current: i + 1,
            total: toUpdate.length,
            phase: `Actualizando precio/stock: ${i + 1} / ${toUpdate.length}...`,
            startedAt: startedAtStr,
            estimatedSecondsLeft: Math.round((toUpdate.length - i - 1) * ratePerItem),
          };
          logger.info(MODULE, `Price/Stock progress: ${i + 1}/${toUpdate.length} (prices=${priceUpdated}, stock=${stockUpdated}, errors=${errors})`);
        }
      }
    }

    state.lastStockSync = new Date().toISOString();
    saveState(state);

    syncStatus.lastStockSync = state.lastStockSync;
    logger.info(MODULE, `Price/Stock sync complete: ${priceUpdated} prices, ${stockUpdated} stock updated, ${skipped} unchanged, ${errors} errors`);
  } catch (err: any) {
    syncStatus.lastError = err.message;
    logger.error(MODULE, `Price/Stock sync failed: ${err.message}`);
  } finally {
    stockSyncRunning = false;
    abortRequested = false;
    syncStatus.isRunning = productSyncRunning;
    syncStatus.progress = null;
  }
}
