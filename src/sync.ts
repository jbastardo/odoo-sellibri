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

// ═══════════════════════════════════════════════════════════════
// ARCHITECTURE: Odoo es MASTER — Sellibri es ESPEJO
// ═══════════════════════════════════════════════════════════════
//
// Principios:
// 1. Todo lo que está en Odoo (activo, vendible, con SKU) DEBE estar en Sellibri
// 2. Todo campo se sobreescribe con el valor de Odoo (título, descripción,
//    precio, stock, categoría, marca, imágenes)
// 3. Productos archivados/inactivos en Odoo → se eliminan de Sellibri
// 4. Productos en Sellibri sin SKU en Odoo → se eliminan de Sellibri
// 5. SKU (default_code en Odoo) = factor comparativo
//
// Flujos:
// - Sync Espejo (cron 1h + botón): comparación completa Odoo vs Sellibri
// - Actualizar SKU (botón): overwrite completo de un solo producto
// - Precio/Stock (cron 15min + botón): solo precio y stock rápido
// ═══════════════════════════════════════════════════════════════

interface ProductSyncEntry {
  sellibriId: number;
  sellibriVariantId: number;
  odooWriteDate: string;
  lastSynced: string;
  lastStock?: number;
  lastPrice?: string;
}

interface SyncState {
  lastMirrorSync: string | null;
  lastStockSync: string | null;
  products: Record<string, ProductSyncEntry>;
}

function loadState(): SyncState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      return {
        lastMirrorSync: raw.lastMirrorSync || raw.lastProductSync || null,
        lastStockSync: raw.lastStockSync || null,
        products: raw.products || {},
      };
    }
  } catch (err: any) {
    logger.warn(MODULE, `Could not load sync state: ${err.message}`);
  }
  return { lastMirrorSync: null, lastStockSync: null, products: {} };
}

function saveState(state: SyncState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err: any) {
    logger.error(MODULE, `Could not save sync state: ${err.message}`);
  }
}

// ─── Sync Progress & Status ─────────────────────────────────────

export interface SyncProgress {
  current: number;
  total: number;
  phase: string;
  startedAt: string | null;
  estimatedSecondsLeft: number | null;
}

export interface SyncStatus {
  lastMirrorSync: string | null;
  lastStockSync: string | null;
  productsSynced: number;
  isRunning: boolean;
  lastError: string | null;
  progress: SyncProgress | null;
}

let syncStatus: SyncStatus = {
  lastMirrorSync: null,
  lastStockSync: null,
  productsSynced: 0,
  isRunning: false,
  lastError: null,
  progress: null,
};

let mirrorSyncRunning = false;
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
    syncStatus.lastMirrorSync = null;
    syncStatus.lastStockSync = null;
    sellibri.invalidateCatalog();
    logger.warn(MODULE, 'Sync state cleared — next sync will start from scratch');
  } catch (err: any) {
    logger.error(MODULE, `Could not clear sync state: ${err.message}`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────

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

/** Validate minimum required data for Sellibri */
function isValidForSellibri(product: odoo.OdooProduct): boolean {
  if (!product.name || product.name.trim() === '') return false;
  const price = parseFloat(getSellibriPrice(product));
  if (isNaN(price) || price <= 0) return false;
  return true;
}

// ─── Image Builder (PRESERVED) ─────────────────────────────────
// This logic builds image attributes from Odoo public URLs
// Main image: /web/image/product.product/{id}/image_1920
// Additional: /web/image/product.image/{image_id}/image_1920

function buildImagesPayload(odooProduct: odoo.OdooProduct): sellibri.SellibriImageAttribute[] {
  const imageUrls = odoo.buildImageUrls(odooProduct);
  const attrs: sellibri.SellibriImageAttribute[] = [];
  const title = cleanTitle(odooProduct.name);

  if (imageUrls.mainUrl) {
    attrs.push({ remote_url: imageUrls.mainUrl, position: 1, alt: title });
  }
  for (const extra of imageUrls.additionalUrls) {
    attrs.push({ remote_url: extra.url, position: extra.position, alt: title });
  }
  return attrs;
}

// ─── Payload Builder: FULL OVERWRITE ───────────────────────────
// Odoo is master: every field is written from Odoo to Sellibri.
// Used for both CREATE and UPDATE — always the same complete payload.

function buildMirrorPayload(
  odooProduct: odoo.OdooProduct,
  includeImages: boolean = true,
): sellibri.SellibriProductPayload {
  const price = getSellibriPrice(odooProduct);
  const description = odooProduct.website_description || odooProduct.description_sale || '';
  const categId = Array.isArray(odooProduct.categ_id) ? odooProduct.categ_id[0] : 0;
  const taxonId = mapCategory(categId);
  const vendorId = mapBrandToVendor(odooProduct.brand_id);
  const title = cleanTitle(odooProduct.name);

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

  // Include images if requested
  if (includeImages) {
    const imagesAttrs = buildImagesPayload(odooProduct);
    if (imagesAttrs.length > 0) {
      masterAttrs.images_attributes = imagesAttrs;
    }
  }

  return {
    product: {
      title,
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
// SYNC ESPEJO — Full mirror: create, update, delete
// ═══════════════════════════════════════════════════════════════
//
// 1. Fetch ALL active products from Odoo
// 2. Fetch ALL products from Sellibri (catalog)
// 3. For each Odoo product:
//    - If in Sellibri → UPDATE with full overwrite
//    - If NOT in Sellibri → CREATE
// 4. For each Sellibri product NOT in Odoo → DELETE
//
// This guarantees Sellibri is always an exact mirror.
// ═══════════════════════════════════════════════════════════════

export interface MirrorSyncResult {
  odooTotal: number;
  sellibriTotal: number;
  created: number;
  updated: number;
  deleted: number;
  skippedInvalid: number;
  errors: number;
}

export async function syncMirror(): Promise<MirrorSyncResult> {
  if (mirrorSyncRunning || stockSyncRunning) {
    logger.warn(MODULE, 'Mirror sync: another sync is running, skipping');
    return { odooTotal: 0, sellibriTotal: 0, created: 0, updated: 0, deleted: 0, skippedInvalid: 0, errors: 0 };
  }
  mirrorSyncRunning = true;
  syncStatus.isRunning = true;
  syncStatus.lastError = null;

  const result: MirrorSyncResult = {
    odooTotal: 0, sellibriTotal: 0, created: 0, updated: 0,
    deleted: 0, skippedInvalid: 0, errors: 0,
  };
  const state = loadState();
  const startTime = Date.now();

  try {
    // ── Phase 1: Load both catalogs ──
    syncStatus.progress = {
      current: 0, total: 0,
      phase: 'Espejo: cargando catálogos Odoo + Sellibri...',
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };

    logger.info(MODULE, 'Mirror sync: loading Odoo products...');
    const odooProducts = await odoo.fetchAllProducts(); // ALL active products (no write_date filter)
    result.odooTotal = odooProducts.length;

    logger.info(MODULE, 'Mirror sync: loading Sellibri catalog...');
    const sellibriCatalog = await sellibri.getCatalog(true); // force reload for accuracy
    result.sellibriTotal = sellibriCatalog.size;

    logger.info(MODULE, `Mirror sync: Odoo=${odooProducts.length}, Sellibri=${sellibriCatalog.size}`);

    // Build Odoo SKU set for later deletion check
    const odooSkuSet = new Set<string>();
    for (const p of odooProducts) {
      if (p.default_code) odooSkuSet.add(p.default_code);
    }

    // ── Phase 2: Create or Update ──
    const totalWork = odooProducts.length;
    const batchStartTime = Date.now();
    let processed = 0;

    for (let i = 0; i < odooProducts.length; i++) {
      if (abortRequested) break;

      const product = odooProducts[i];
      const sku = product.default_code;
      if (!sku) { processed++; continue; }

      // Validate
      if (!isValidForSellibri(product)) {
        result.skippedInvalid++;
        processed++;
        updateProgress(processed, totalWork, batchStartTime, 'Espejo:');
        continue;
      }

      try {
        const existing = sellibriCatalog.get(sku);

        if (existing) {
          // ── UPDATE: overwrite all fields from Odoo ──
          const payload = buildMirrorPayload(product, true);
          await sellibri.updateProduct(existing.id, payload);
          result.updated++;

          state.products[sku] = {
            sellibriId: existing.id,
            sellibriVariantId: existing.all_variants?.[0]?.id || 0,
            odooWriteDate: product.write_date,
            lastSynced: new Date().toISOString(),
            lastStock: Math.max(0, Math.floor(product.qty_available || 0)),
            lastPrice: getSellibriPrice(product),
          };
        } else {
          // ── CREATE: new product in Sellibri ──
          const payload = buildMirrorPayload(product, true);
          const newProduct = await sellibri.createProduct(payload);
          result.created++;
          logger.info(MODULE, `Created SKU=${sku} (id=${newProduct.id})`);

          state.products[sku] = {
            sellibriId: newProduct.id,
            sellibriVariantId: newProduct.all_variants?.[0]?.id || 0,
            odooWriteDate: product.write_date,
            lastSynced: new Date().toISOString(),
            lastStock: Math.max(0, Math.floor(product.qty_available || 0)),
            lastPrice: getSellibriPrice(product),
          };
        }
      } catch (err: any) {
        result.errors++;
        const status = (err as any)?.response?.status;
        if (status === 400) {
          logger.warn(MODULE, `SKU=${sku}: 400 Bad Request (skipped)`);
        } else {
          logger.error(MODULE, `Error SKU=${sku}: ${err.message}`);
        }
      }

      processed++;
      updateProgress(processed, totalWork, batchStartTime, 'Espejo:');

      if (processed % 100 === 0) {
        saveState(state);
        logger.info(MODULE, `Progress: ${processed}/${totalWork} (created=${result.created}, updated=${result.updated}, errors=${result.errors})`);
      }
    }

    // ── Phase 3: Delete orphans (in Sellibri but NOT in Odoo) ──
    if (!abortRequested) {
      syncStatus.progress = {
        current: 0, total: 0,
        phase: 'Espejo: eliminando productos huérfanos de Sellibri...',
        startedAt: syncStatus.progress?.startedAt || new Date().toISOString(),
        estimatedSecondsLeft: null,
      };

      const orphans: { sku: string; sellibriId: number }[] = [];
      const seenIds = new Set<number>();

      for (const [sku, product] of sellibriCatalog) {
        if (!odooSkuSet.has(sku) && !seenIds.has(product.id)) {
          orphans.push({ sku, sellibriId: product.id });
          seenIds.add(product.id);
        }
      }

      if (orphans.length > 0) {
        logger.info(MODULE, `Mirror sync: ${orphans.length} orphan products to delete`);
        const deleteStart = Date.now();

        for (let i = 0; i < orphans.length; i++) {
          if (abortRequested) break;
          const orphan = orphans[i];
          try {
            await sellibri.deleteProduct(orphan.sellibriId, orphan.sku);
            result.deleted++;
            delete state.products[orphan.sku];
          } catch (err: any) {
            result.errors++;
            logger.error(MODULE, `Delete error SKU=${orphan.sku}: ${err.message}`);
          }
          updateProgress(i + 1, orphans.length, deleteStart, 'Eliminando:');
        }
      }
    }

    // ── Finalize ──
    state.lastMirrorSync = new Date().toISOString();

    // Clean state: remove SKUs that are no longer in Odoo
    for (const sku of Object.keys(state.products)) {
      if (!odooSkuSet.has(sku)) {
        delete state.products[sku];
      }
    }

    saveState(state);
    syncStatus.lastMirrorSync = state.lastMirrorSync;
    syncStatus.productsSynced = Object.keys(state.products).length;

    const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    logger.info(MODULE, `Mirror sync ${abortRequested ? 'ABORTED' : 'complete'} in ${totalTime}min: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted, ${result.skippedInvalid} invalid, ${result.errors} errors`);
  } catch (err: any) {
    syncStatus.lastError = err.message;
    logger.error(MODULE, `Mirror sync failed: ${err.message}`);
  } finally {
    mirrorSyncRunning = false;
    abortRequested = false;
    syncStatus.isRunning = stockSyncRunning;
    syncStatus.progress = null;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// ACTUALIZAR SKU — Full overwrite of a single product
// ═══════════════════════════════════════════════════════════════

export async function syncSingleSku(sku: string): Promise<{ success: boolean; message: string }> {
  logger.info(MODULE, `Actualizar SKU=${sku}...`);

  try {
    const odooProduct = await odoo.fetchProductBySku(sku);
    if (!odooProduct) {
      return { success: false, message: `SKU ${sku} no encontrado en Odoo` };
    }

    if (!isValidForSellibri(odooProduct)) {
      return { success: false, message: `SKU ${sku} no tiene datos válidos (precio=0 o sin nombre)` };
    }

    // Look up in Sellibri
    const catalog = await sellibri.getCatalog();
    let existing = catalog.get(sku) || null;

    // Fallback: check state
    if (!existing) {
      const state = loadState();
      const cached = state.products[sku];
      if (cached?.sellibriId) {
        existing = await sellibri.fetchProductById(cached.sellibriId);
      }
    }

    // Build full overwrite payload WITH images
    const payload = buildMirrorPayload(odooProduct, true);

    let sellibriId: number;
    let variantId: number;

    if (existing) {
      await sellibri.updateProduct(existing.id, payload);
      sellibriId = existing.id;
      variantId = existing.all_variants?.[0]?.id || 0;
      logger.info(MODULE, `Updated SKU=${sku} (id=${sellibriId}) — full overwrite`);
    } else {
      const newProduct = await sellibri.createProduct(payload);
      sellibriId = newProduct.id;
      variantId = newProduct.all_variants?.[0]?.id || 0;
      logger.info(MODULE, `Created SKU=${sku} (id=${sellibriId})`);
    }

    // Also sync images separately (in case the payload didn't include them or they need update)
    let imageMsg = '';
    try {
      const hasOdooImage = await odoo.productHasImage(odooProduct.id);
      if (hasOdooImage) {
        const imagesAttrs = buildImagesPayload(odooProduct);
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
    state.products[sku] = {
      sellibriId,
      sellibriVariantId: variantId,
      odooWriteDate: odooProduct.write_date,
      lastSynced: new Date().toISOString(),
      lastStock: Math.max(0, Math.floor(odooProduct.qty_available || 0)),
      lastPrice: getSellibriPrice(odooProduct),
    };
    saveState(state);

    return {
      success: true,
      message: existing
        ? `SKU ${sku} actualizado (overwrite completo)${imageMsg}`
        : `SKU ${sku} creado en Sellibri${imageMsg}`,
    };
  } catch (err: any) {
    logger.error(MODULE, `Actualizar SKU=${sku} failed: ${err.message}`);
    return { success: false, message: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// PRECIO/STOCK — Fast sync (cron 15min + manual button)
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
    syncStatus.isRunning = mirrorSyncRunning;
    syncStatus.progress = null;
  }
}
