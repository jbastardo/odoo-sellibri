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
    sellibri.invalidateCatalog();
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

/**
 * Detect if a product name contains Odoo's copy/duplicate markers.
 * Odoo adds "(copia)", "(Copia)", "(copy)", "(Copy)", "(copiar)" etc.
 * when duplicating a product.
 */
function hasCopyMarker(name: string): boolean {
  if (!name) return false;
  // Match patterns like (copia), (Copia), (copy), (Copy), (copiar), (Copiar)
  // Also handles multiple copies: (copia) (copia), (copia 2), etc.
  return /\(copia[r]?(\s*\d*)?\)|\(copy(\s*\d*)?\)/i.test(name);
}

/**
 * Remove Odoo's copy/duplicate markers from a product name.
 * Examples:
 *   "Producto X (copia)" → "Producto X"
 *   "Producto X (Copia) (Copia)" → "Producto X"
 *   "Producto X (copiar)" → "Producto X"
 *   "Producto X (copy)" → "Producto X"
 *   "Producto X (copia 2)" → "Producto X"
 */
function cleanTitle(name: string): string {
  if (!name) return name;
  return name
    .replace(/\s*\(copia[r]?(\s*\d*)?\)/gi, '')
    .replace(/\s*\(copy(\s*\d*)?\)/gi, '')
    .trim();
}

function getSellibriPrice(product: odoo.OdooProduct): string {
  const pwt = product.price_with_tax;
  if (pwt && pwt > 0) return pwt.toFixed(2);
  return (product.list_price * (1 + config.ivaRate)).toFixed(2);
}

function updateProgress(done: number, total: number, batchStartTime: number, prefix = 'Sincronizando'): void {
  const elapsed = (Date.now() - batchStartTime) / 1000;
  const rate = done > 0 ? elapsed / done : 1;
  const remaining = Math.max(0, total - done);
  syncStatus.progress = {
    current: done,
    total,
    phase: `${prefix} ${done} / ${total}...`,
    startedAt: syncStatus.progress?.startedAt || new Date().toISOString(),
    estimatedSecondsLeft: Math.round(remaining * rate),
  };
}

/** Validate that a product has minimum required data for Sellibri */
function isValidForSellibri(product: odoo.OdooProduct): boolean {
  if (!product.name || product.name.trim() === '') return false;
  const price = parseFloat(getSellibriPrice(product));
  if (isNaN(price) || price <= 0) return false;
  return true;
}

/** Check if an Odoo product name has copy markers — these should be skipped for title writes */
function shouldSkipTitle(product: odoo.OdooProduct): boolean {
  return hasCopyMarker(product.name);
}

// ─── Payload Builders ──────────────────────────────────────────

/**
 * Build a PARTIAL update payload — only changed fields.
 * Compares Odoo data against Sellibri data entirely in memory.
 * Returns null if nothing changed (= skip the API call entirely).
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

  // If product is hidden (draft) → force active
  if (sellibriProduct.status !== 'active') {
    needsUpdate = true;
  }

  // Slug: set to SKU if different
  if (sellibriProduct.slug !== odooProduct.default_code) {
    productFields.slug = odooProduct.default_code;
    needsUpdate = true;
  }

  // Price — update if different
  const currentPrice = parseFloat(variant.price || '0');
  const newPrice = parseFloat(odooPrice);
  if (Math.abs(currentPrice - newPrice) > 0.01) {
    masterAttrs.price = odooPrice;
    needsUpdate = true;
  }

  // Stock — update if different
  const currentStock = variant.stock_items?.[0]?.available ?? 0;
  if (currentStock !== odooStock) {
    masterAttrs.stock_items_attributes = [{
      stock_location_id: config.sellibri.stockLocationId,
      available: odooStock,
    }];
    needsUpdate = true;
  }

  // Title: update if empty in Sellibri, or if different from cleaned Odoo name
  const cleanedTitle = cleanTitle(odooProduct.name);
  if (cleanedTitle && (isEmpty(sellibriProduct.title) || sellibriProduct.title !== cleanedTitle)) {
    productFields.title = cleanedTitle;
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
      title: productFields.title || sellibriProduct.title || cleanTitle(odooProduct.name),
      ...(productFields.slug ? { slug: productFields.slug } : {}),
      status: 'active',
      ...(productFields.description !== undefined ? { description: productFields.description } : {}),
      ...(productFields.product_vendor_id ? { product_vendor_id: productFields.product_vendor_id } : {}),
      master_attributes: masterAttrs,
      taxon_ids: productFields.taxon_ids || sellibriProduct.taxon_ids || [taxonId],
    },
  };
}

/** Build a FULL payload for creating new products.
 *  Copy markers like (copia)/(copiar) are automatically cleaned from the title. */
function buildFullPayload(
  odooProduct: odoo.OdooProduct,
): sellibri.SellibriProductPayload {
  const price = getSellibriPrice(odooProduct);
  const description = odooProduct.website_description || odooProduct.description_sale || '';
  const categId = Array.isArray(odooProduct.categ_id) ? odooProduct.categ_id[0] : 0;
  const taxonId = mapCategory(categId);
  const vendorId = mapBrandToVendor(odooProduct.brand_id);

  // Build image attributes from Odoo URLs
  const imageUrls = odoo.buildImageUrls(odooProduct);
  const imagesAttrs: sellibri.SellibriImageAttribute[] = [];
  if (imageUrls.mainUrl) {
    imagesAttrs.push({
      remote_url: imageUrls.mainUrl,
      position: 1,
      alt: cleanTitle(odooProduct.name),
    });
  }
  for (const extra of imageUrls.additionalUrls) {
    imagesAttrs.push({
      remote_url: extra.url,
      position: extra.position,
      alt: cleanTitle(odooProduct.name),
    });
  }

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
    ...(imagesAttrs.length > 0 ? { images_attributes: imagesAttrs } : {}),
  };

  return {
    product: {
      title: cleanTitle(odooProduct.name),
      slug: odooProduct.default_code,
      status: 'active',
      description: typeof description === 'string' ? description : '',
      ...(vendorId ? { product_vendor_id: vendorId } : {}),
      master_attributes: masterAttrs,
      taxon_ids: [taxonId],
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// PRODUCT SYNC — Optimized
// ═══════════════════════════════════════════════════════════════
//
// Architecture:
// 1. Load Sellibri catalog ONCE into memory (cached for 30 min)
// 2. Fetch only CHANGED products from Odoo (using write_date filter)
// 3. For each changed product, compare IN MEMORY against Sellibri
//    - If SKU exists in catalog → build smart diff → PATCH only if different
//    - If SKU not in catalog → CREATE (no extra API calls to verify)
// 4. The catalog cache is updated after each create/update
//    so subsequent operations see the latest data.
//
// This means:
// - First run: ~110 GET pages to load catalog + N PATCHes for changed products
// - Subsequent runs: 0 GET pages (cached) + only PATCHes for changes
// - Cron (price/stock): 0 GET pages + only PATCHes for changed prices/stock
//
// Anti-duplication: catalog cache is the single source of truth.
// Since it's loaded fully and updated on every create, if a SKU
// exists anywhere in Sellibri, it will be in the cache.
// ═══════════════════════════════════════════════════════════════

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
  let duplicatePrevented = 0;
  const syncStartTime = Date.now();

  try {
    // ── Phase 1: Load Sellibri catalog (cached in memory) ──
    syncStatus.progress = {
      current: 0, total: 0,
      phase: 'Cargando catálogo Sellibri...',
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };
    logger.info(MODULE, 'Phase 1: Loading Sellibri catalog...');
    const catalog = await sellibri.getCatalog();
    logger.info(MODULE, `Sellibri catalog: ${catalog.size} SKUs`);

    // Merge catalog into state (for products not yet in state)
    for (const [sku, product] of catalog) {
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

    // ── Phase 2: Fetch ONLY changed products from Odoo ──
    syncStatus.progress.phase = 'Obteniendo productos modificados de Odoo...';
    logger.info(MODULE, 'Phase 2: Fetching changed products from Odoo...');
    const lastWrite = state.lastProductWriteDate || undefined;
    const products = await odoo.fetchAllProducts(lastWrite);
    logger.info(MODULE, `Odoo returned ${products.length} changed products`);

    if (products.length === 0) {
      logger.info(MODULE, 'No products changed since last sync');
      state.lastProductSync = new Date().toISOString();
      saveState(state);
      syncStatus.lastProductSync = state.lastProductSync;
      syncStatus.productsSynced = Object.keys(state.products).length;
      return;
    }

    // ── Phase 3: Process changes ──
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

      // Skip if product write_date hasn't changed since last sync
      const cached = state.products[sku];
      if (cached && cached.odooWriteDate === product.write_date) {
        skipped++;
        updateProgress(synced + created + skipped + errors + invalidSkipped, total, batchStartTime);
        continue;
      }

      // Validate product data
      if (!isValidForSellibri(product)) {
        invalidSkipped++;
        updateProgress(synced + created + skipped + errors + invalidSkipped, total, batchStartTime);
        continue;
      }

      try {
        // Look up in in-memory catalog (instant — no API call)
        const existingInCatalog = catalog.get(sku);

        let sellibriId: number;
        let variantId: number;

        if (existingInCatalog) {
          // ── EXISTING: compare in memory, PATCH only if different ──
          const wasDraft = existingInCatalog.status !== 'active';
          const payload = buildSmartPayload(product, existingInCatalog);

          if (payload) {
            await sellibri.updateProduct(existingInCatalog.id, payload);
            synced++;
            if (wasDraft) activated++;
          } else {
            skipped++; // Nothing changed — no API call needed
          }

          sellibriId = existingInCatalog.id;
          variantId = existingInCatalog.all_variants?.[0]?.id || 0;
        } else if (cached?.sellibriId) {
          // In state but not in catalog (maybe catalog load was incomplete)
          // Fetch directly by ID to confirm existence before creating
          const existingById = await sellibri.fetchProductById(cached.sellibriId);
          if (existingById) {
            const wasDraft = existingById.status !== 'active';
            const payload = buildSmartPayload(product, existingById);
            if (payload) {
              await sellibri.updateProduct(existingById.id, payload);
              synced++;
              if (wasDraft) activated++;
            } else {
              skipped++;
            }
            sellibriId = existingById.id;
            variantId = existingById.all_variants?.[0]?.id || 0;
            duplicatePrevented++;
          } else {
            // State entry is stale — product was deleted from Sellibri, create fresh
            const payload = buildFullPayload(product);
            const newProduct = await sellibri.createProduct(payload);
            sellibriId = newProduct.id;
            variantId = newProduct.all_variants?.[0]?.id || 0;
            created++;
            logger.info(MODULE, `Created SKU=${sku} (id=${sellibriId})`);
          }
        } else {
          // ── TRULY NEW: not in catalog, not in state → create ──
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
        logger.info(MODULE, `Progress: ${done}/${total} (updated=${synced}, created=${created}, activated=${activated}, skipped=${skipped}, invalid=${invalidSkipped}, dupes_prevented=${duplicatePrevented}, errors=${errors})`);
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
    const msg = `Product sync ${abortRequested ? 'ABORTED' : 'complete'} in ${totalTime}min: ${created} created, ${synced} updated, ${activated} activated, ${skipped} skipped, ${invalidSkipped} invalid, ${duplicatePrevented} dupes prevented, ${errors} errors`;
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

    // Look up in cached catalog (instant)
    const catalog = await sellibri.getCatalog();
    let existingProduct = catalog.get(sku) || null;

    // Fallback: check state if not in catalog
    if (!existingProduct) {
      const state = loadState();
      const cached = state.products[sku];
      if (cached?.sellibriId) {
        existingProduct = await sellibri.fetchProductById(cached.sellibriId);
      }
    }

    const payload = buildFullPayload(odooProduct);

    let sellibriId: number;
    let variantId: number;

    if (existingProduct) {
      // For existing products, use smart payload (updates only changed fields)
      const smartPayload = buildSmartPayload(odooProduct, existingProduct);
      if (smartPayload) {
        await sellibri.updateProduct(existingProduct.id, smartPayload);
      }
      sellibriId = existingProduct.id;
      variantId = existingProduct.all_variants?.[0]?.id || 0;
      logger.info(MODULE, `Force-updated SKU=${sku} (id=${sellibriId})`);
    } else {
      const newProduct = await sellibri.createProduct(payload);
      sellibriId = newProduct.id;
      variantId = newProduct.all_variants?.[0]?.id || 0;
      logger.info(MODULE, `Force-created SKU=${sku} (id=${sellibriId})`);
    }

    // ── Always sync images ──────────────────────────────────────
    let imageMsg = '';
    try {
      const hasOdooImage = await odoo.productHasImage(odooProduct.id);
      if (hasOdooImage) {
        const imageUrls = odoo.buildImageUrls(odooProduct);
        const title = cleanTitle(odooProduct.name);
        const imagesAttrs: sellibri.SellibriImageAttribute[] = [];

        if (imageUrls.mainUrl) {
          imagesAttrs.push({ remote_url: imageUrls.mainUrl, position: 1, alt: title });
        }
        for (const extra of imageUrls.additionalUrls) {
          imagesAttrs.push({ remote_url: extra.url, position: extra.position, alt: title });
        }

        if (imagesAttrs.length > 0) {
          await sellibri.updateProduct(sellibriId, {
            product: {
              master_attributes: {
                images_attributes: imagesAttrs,
              },
            },
          });
          imageMsg = ` + ${imagesAttrs.length} imágenes`;
          logger.info(MODULE, `SKU=${sku}: ${imagesAttrs.length} images synced`);
        }
      }
    } catch (imgErr: any) {
      logger.warn(MODULE, `SKU=${sku}: image sync failed (non-blocking): ${imgErr.message}`);
      imageMsg = ' (imágenes fallaron)';
    }

    const state = loadState();
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
        ? `SKU ${sku} actualizado${imageMsg}`
        : `SKU ${sku} creado en Sellibri${imageMsg}`,
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
    // Phase 1: Load catalogs
    syncStatus.progress = {
      current: 0, total: 0,
      phase: 'Limpieza: cargando catálogos...',
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };
    logger.info(MODULE, 'Cleanup: Loading catalogs...');
    const sellibriCatalog = await sellibri.getCatalog(true); // force reload for accuracy
    result.totalSellibri = sellibriCatalog.size;

    const odooSKUs = await odoo.fetchAllActiveSKUs();
    result.totalOdoo = odooSKUs.size;
    logger.info(MODULE, `Sellibri: ${sellibriCatalog.size} | Odoo: ${odooSKUs.size}`);

    // Phase 2: Find orphans
    const orphans: { sku: string; sellibriId: number }[] = [];
    const seenIds = new Set<number>();

    for (const [sku, product] of sellibriCatalog) {
      if (!odooSKUs.has(sku) && !seenIds.has(product.id)) {
        orphans.push({ sku, sellibriId: product.id });
        seenIds.add(product.id);
        result.orphanSkus.push(sku);
      }
    }

    logger.info(MODULE, `Found ${orphans.length} orphan products`);
    if (orphans.length === 0) return result;

    // Phase 3: Delete orphans
    const total = orphans.length;
    const batchStartTime = Date.now();
    const state = loadState();

    for (let i = 0; i < orphans.length; i++) {
      if (abortRequested) break;

      const orphan = orphans[i];
      try {
        const deleted = await sellibri.deleteProduct(orphan.sellibriId, orphan.sku);
        if (deleted) {
          result.deleted++;
          delete state.products[orphan.sku];
        } else {
          result.failed++;
        }
      } catch (err: any) {
        result.failed++;
        logger.error(MODULE, `Cleanup: failed SKU=${orphan.sku}: ${err.message}`);
      }

      const done = result.deleted + result.failed;
      updateProgress(done, total, batchStartTime, 'Limpieza:');

      if (done % 50 === 0) {
        saveState(state);
        logger.info(MODULE, `Cleanup: ${done}/${total} (deleted=${result.deleted}, failed=${result.failed})`);
      }
    }

    saveState(state);
    logger.info(MODULE, `Cleanup complete: ${result.deleted} deleted, ${result.failed} failed`);
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

// ─── Fix Titles & SKU ──────────────────────────────────────────

let fixTitlesRunning = false;

export interface FixTitlesResult {
  total: number;
  matched: number;
  titleFixed: number;
  skuFixed: number;
  slugFixed: number;
  skipped: number;
  errors: number;
}

export async function syncFixTitlesSku(): Promise<FixTitlesResult> {
  if (fixTitlesRunning || productSyncRunning || stockSyncRunning) {
    logger.warn(MODULE, 'Fix titles: another sync is running, skipping');
    return { total: 0, matched: 0, titleFixed: 0, skuFixed: 0, slugFixed: 0, skipped: 0, errors: 0 };
  }
  fixTitlesRunning = true;
  syncStatus.isRunning = true;
  syncStatus.lastError = null;

  const result: FixTitlesResult = {
    total: 0, matched: 0, titleFixed: 0, skuFixed: 0, slugFixed: 0, skipped: 0, errors: 0,
  };

  try {
    syncStatus.progress = {
      current: 0, total: 0,
      phase: 'Corregir Títulos/SKU: cargando catálogos...',
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };

    const catalog = await sellibri.getCatalog();
    const odooProducts = await odoo.fetchAllProducts();
    logger.info(MODULE, `Fix titles: ${catalog.size} Sellibri, ${odooProducts.length} Odoo`);

    // Compare in memory
    const toFix: { odoo: odoo.OdooProduct; sellibri: sellibri.SellibriProduct }[] = [];

    for (const op of odooProducts) {
      const sku = op.default_code;
      if (!sku) continue;
      result.total++;

      const sp = catalog.get(sku);
      if (!sp) continue;
      result.matched++;

      const variant = sp.all_variants?.[0];
      if (!variant) continue;

      // Clean the Odoo title (remove copy markers) before comparing
      const odooTitle = cleanTitle((op.name || '').trim());
      const sellibriTitle = (sp.title || '').trim();
      // If Odoo title is just a copy marker with no real name, skip
      if (!odooTitle) {
        result.skipped++;
        continue;
      }
      const titleDiff = odooTitle && sellibriTitle !== odooTitle;

      const sellibriSku = (variant.sku || '').trim();
      const skuDiff = sku && sellibriSku !== sku;

      const sellibriSlug = (sp.slug || '').trim();
      const slugDiff = sku && sellibriSlug !== sku;

      if (titleDiff || skuDiff || slugDiff) {
        toFix.push({ odoo: op, sellibri: sp });
      } else {
        result.skipped++;
      }
    }

    logger.info(MODULE, `Fix titles: ${toFix.length} need correction, ${result.skipped} already correct`);
    if (toFix.length === 0) return result;

    const total = toFix.length;
    const batchStartTime = Date.now();

    for (let i = 0; i < toFix.length; i++) {
      if (abortRequested) break;

      const { odoo: op, sellibri: sp } = toFix[i];
      const sku = op.default_code;
      const variant = sp.all_variants?.[0];

      try {
        const odooTitle = cleanTitle((op.name || '').trim());
        const sellibriTitle = (sp.title || '').trim();
        const sellibriSku = (variant?.sku || '').trim();

        const titleNeedsFix = odooTitle && sellibriTitle !== odooTitle;
        const skuNeedsFix = sku && sellibriSku !== sku;
        const slugNeedsFix = sku && (sp.slug || '').trim() !== sku;

        const payload: sellibri.SellibriProductPayload = { product: {} };

        if (titleNeedsFix) payload.product.title = odooTitle;
        if (skuNeedsFix) payload.product.master_attributes = { sku };
        if (slugNeedsFix) payload.product.slug = sku;
        if (!payload.product.title) payload.product.title = sellibriTitle || odooTitle;

        await sellibri.updateProduct(sp.id, payload);

        if (titleNeedsFix) result.titleFixed++;
        if (skuNeedsFix) result.skuFixed++;
        if (slugNeedsFix) result.slugFixed++;
      } catch (err: any) {
        result.errors++;
        logger.error(MODULE, `Fix title error SKU=${sku}: ${err.message}`);
      }

      updateProgress(i + 1, total, batchStartTime, 'Corrigiendo títulos/SKU:');

      if ((i + 1) % 50 === 0) {
        logger.info(MODULE, `Fix titles: ${i + 1}/${total} (titles=${result.titleFixed}, skus=${result.skuFixed}, slugs=${result.slugFixed}, errors=${result.errors})`);
      }
    }

    const totalTime = ((Date.now() - batchStartTime) / 1000 / 60).toFixed(1);
    logger.info(MODULE, `Fix titles ${abortRequested ? 'ABORTED' : 'complete'} in ${totalTime}min: ${result.titleFixed} titles, ${result.skuFixed} SKUs, ${result.slugFixed} slugs, ${result.errors} errors`);
  } catch (err: any) {
    syncStatus.lastError = err.message;
    logger.error(MODULE, `Fix titles failed: ${err.message}`);
  } finally {
    fixTitlesRunning = false;
    abortRequested = false;
    syncStatus.isRunning = productSyncRunning || stockSyncRunning;
    syncStatus.progress = null;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// PRICE/STOCK SYNC — Optimized
// ═══════════════════════════════════════════════════════════════
//
// Flow:
// 1. Fetch all SKU/price/stock from Odoo in 1 bulk call
// 2. Compare against LOCAL state (lastPrice, lastStock)
// 3. Only PATCH products where price or stock actually changed
//
// This is already efficient — the only API calls are the PATCHes
// for products that genuinely changed.
// ═══════════════════════════════════════════════════════════════

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

    logger.info(MODULE, `Price/stock sync for ${trackedSkus.length} tracked products`);

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

    logger.info(MODULE, `Odoo data fetched: ${odooDataMap.size} products`);

    // Build list of products that actually changed
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
      logger.info(MODULE, `No price/stock changes (${skipped} unchanged)`);
    } else {
      logger.info(MODULE, `${toUpdate.length} products need update, ${skipped} unchanged`);

      const batchStartTime = Date.now();
      syncStatus.progress = {
        current: 0, total: toUpdate.length,
        phase: `Actualizando precio/stock: 0 / ${toUpdate.length}...`,
        startedAt: new Date().toISOString(),
        estimatedSecondsLeft: null,
      };

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
          updateProgress(i + 1, toUpdate.length, batchStartTime, 'Actualizando precio/stock:');
          logger.info(MODULE, `Price/Stock: ${i + 1}/${toUpdate.length} (prices=${priceUpdated}, stock=${stockUpdated}, errors=${errors})`);
        }
      }
    }

    state.lastStockSync = new Date().toISOString();
    saveState(state);

    syncStatus.lastStockSync = state.lastStockSync;
    logger.info(MODULE, `Price/Stock sync complete: ${priceUpdated} prices, ${stockUpdated} stock, ${skipped} unchanged, ${errors} errors`);
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

// ═══════════════════════════════════════════════════════════════
// IMAGE SYNC — Upload images from Odoo to Sellibri via remote_url
// ═══════════════════════════════════════════════════════════════

export interface ImageSyncResult {
  success: boolean;
  message: string;
  imagesUploaded: number;
  details?: {
    mainUrl: string | null;
    additionalUrls: string[];
    sellibriResponse?: any;
  };
}

/** Sync images for a single SKU — test/debug function */
export async function syncSingleSkuImages(sku: string): Promise<ImageSyncResult> {
  logger.info(MODULE, `Image sync for SKU=${sku}...`);

  try {
    // 1. Get product from Odoo
    const odooProduct = await odoo.fetchProductBySku(sku);
    if (!odooProduct) {
      return { success: false, message: `SKU ${sku} no encontrado en Odoo`, imagesUploaded: 0 };
    }

    // 2. Check if product has an image in Odoo
    const hasImage = await odoo.productHasImage(odooProduct.id);
    if (!hasImage) {
      return { success: false, message: `SKU ${sku} no tiene imagen principal en Odoo`, imagesUploaded: 0 };
    }

    // 3. Build image URLs
    const imageUrls = odoo.buildImageUrls(odooProduct);
    logger.info(MODULE, `SKU=${sku}: main=${imageUrls.mainUrl}, additional=${imageUrls.additionalUrls.length}`);

    // 4. Find product in Sellibri
    const catalog = await sellibri.getCatalog();
    const sellibriProduct = catalog.get(sku);
    if (!sellibriProduct) {
      return { success: false, message: `SKU ${sku} no encontrado en Sellibri — sincroniza productos primero`, imagesUploaded: 0 };
    }

    // 5. Build images_attributes payload
    const imagesAttrs: sellibri.SellibriImageAttribute[] = [];
    const title = cleanTitle(odooProduct.name);

    if (imageUrls.mainUrl) {
      imagesAttrs.push({
        remote_url: imageUrls.mainUrl,
        position: 1,
        alt: title,
      });
    }
    for (const extra of imageUrls.additionalUrls) {
      imagesAttrs.push({
        remote_url: extra.url,
        position: extra.position,
        alt: title,
      });
    }

    if (imagesAttrs.length === 0) {
      return { success: false, message: `SKU ${sku} no tiene imágenes en Odoo`, imagesUploaded: 0 };
    }

    // 6. Send to Sellibri
    const payload: sellibri.SellibriProductPayload = {
      product: {
        master_attributes: {
          images_attributes: imagesAttrs,
        },
      },
    };

    logger.info(MODULE, `SKU=${sku}: sending ${imagesAttrs.length} images to Sellibri (id=${sellibriProduct.id})`);
    logger.info(MODULE, `Payload: ${JSON.stringify(payload, null, 2)}`);

    const result = await sellibri.updateProduct(sellibriProduct.id, payload);

    return {
      success: true,
      message: `SKU ${sku}: ${imagesAttrs.length} imágenes enviadas a Sellibri`,
      imagesUploaded: imagesAttrs.length,
      details: {
        mainUrl: imageUrls.mainUrl,
        additionalUrls: imageUrls.additionalUrls.map(u => u.url),
        sellibriResponse: result,
      },
    };
  } catch (err: any) {
    const responseData = err?.response?.data;
    const msg = responseData ? JSON.stringify(responseData) : err.message;
    logger.error(MODULE, `Image sync SKU=${sku} failed: ${msg}`);
    return { success: false, message: `Error: ${msg}`, imagesUploaded: 0 };
  }
}

// ─── Batch Image Sync ─────────────────────────────────────────────

let imageSyncRunning = false;

export interface BatchImageSyncResult {
  total: number;
  matched: number;
  uploaded: number;
  skippedHasImages: number;
  skippedNoOdooImage: number;
  errors: number;
}

/** Batch sync images for all products: sends Odoo image URLs to Sellibri.
 *  Only processes products that currently have NO images in Sellibri. */
export async function syncImagesAll(): Promise<BatchImageSyncResult> {
  if (imageSyncRunning || productSyncRunning || stockSyncRunning) {
    logger.warn(MODULE, 'Image sync: another sync is running, skipping');
    return { total: 0, matched: 0, uploaded: 0, skippedHasImages: 0, skippedNoOdooImage: 0, errors: 0 };
  }
  imageSyncRunning = true;
  syncStatus.isRunning = true;
  syncStatus.lastError = null;

  const result: BatchImageSyncResult = {
    total: 0, matched: 0, uploaded: 0, skippedHasImages: 0, skippedNoOdooImage: 0, errors: 0,
  };

  try {
    syncStatus.progress = {
      current: 0, total: 0,
      phase: 'Sync Imágenes: cargando catálogos...',
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };

    const catalog = await sellibri.getCatalog();
    const odooProducts = await odoo.fetchAllProducts();
    logger.info(MODULE, `Image sync: ${catalog.size} Sellibri, ${odooProducts.length} Odoo`);

    // Build list of products that need images
    const toProcess: { odoo: odoo.OdooProduct; sellibri: sellibri.SellibriProduct }[] = [];

    for (const op of odooProducts) {
      const sku = op.default_code;
      if (!sku) continue;
      result.total++;

      const sp = catalog.get(sku);
      if (!sp) continue;
      result.matched++;

      // Skip if Sellibri product already has images
      const variant = sp.all_variants?.[0];
      if (variant?.images && variant.images.length > 0) {
        result.skippedHasImages++;
        continue;
      }

      // Skip if Odoo product has no images
      if (!op.product_template_image_ids || op.product_template_image_ids.length === 0) {
        // Only has main image (no additional), still worth syncing
        // We’ll check main image existence during processing
      }

      toProcess.push({ odoo: op, sellibri: sp });
    }

    logger.info(MODULE, `Image sync: ${toProcess.length} products need images, ${result.skippedHasImages} already have images`);
    if (toProcess.length === 0) return result;

    const total = toProcess.length;
    const batchStartTime = Date.now();

    for (let i = 0; i < toProcess.length; i++) {
      if (abortRequested) break;

      const { odoo: op, sellibri: sp } = toProcess[i];
      const sku = op.default_code;

      try {
        const imageUrls = odoo.buildImageUrls(op);
        const title = cleanTitle(op.name);
        const imagesAttrs: sellibri.SellibriImageAttribute[] = [];

        if (imageUrls.mainUrl) {
          imagesAttrs.push({ remote_url: imageUrls.mainUrl, position: 1, alt: title });
        }
        for (const extra of imageUrls.additionalUrls) {
          imagesAttrs.push({ remote_url: extra.url, position: extra.position, alt: title });
        }

        if (imagesAttrs.length === 0) {
          result.skippedNoOdooImage++;
          continue;
        }

        await sellibri.updateProduct(sp.id, {
          product: {
            master_attributes: {
              images_attributes: imagesAttrs,
            },
          },
        });

        result.uploaded++;
      } catch (err: any) {
        result.errors++;
        logger.error(MODULE, `Image sync error SKU=${sku}: ${err.message}`);
      }

      updateProgress(i + 1, total, batchStartTime, 'Sync Imágenes:');

      if ((i + 1) % 50 === 0) {
        logger.info(MODULE, `Image sync: ${i + 1}/${total} (uploaded=${result.uploaded}, skippedNoImage=${result.skippedNoOdooImage}, errors=${result.errors})`);
      }
    }

    const totalTime = ((Date.now() - batchStartTime) / 1000 / 60).toFixed(1);
    logger.info(MODULE, `Image sync ${abortRequested ? 'ABORTED' : 'complete'} in ${totalTime}min: ${result.uploaded} uploaded, ${result.skippedHasImages} already had images, ${result.skippedNoOdooImage} no Odoo image, ${result.errors} errors`);
  } catch (err: any) {
    syncStatus.lastError = err.message;
    logger.error(MODULE, `Image sync failed: ${err.message}`);
  } finally {
    imageSyncRunning = false;
    abortRequested = false;
    syncStatus.isRunning = productSyncRunning || stockSyncRunning;
    syncStatus.progress = null;
  }

  return result;
}
