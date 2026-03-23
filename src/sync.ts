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
 */
function cleanName(name: string): string {
  if (!name) return name;
  return name
    .replace(/\s*\(copia[r]?(\s*\d*)?\)/gi, '')
    .replace(/\s*\(copy(\s*\d*)?\)/gi, '')
    .trim();
}

/**
 * Get the title that should be displayed for a product.
 * Priority: seo_name > name (cleaned of copy markers)
 * seo_name is what the Odoo website shows to users.
 * When products are duplicated in Odoo, the 'name' field may keep
 * the old product's name, but seo_name is always the user-edited title.
 */
function getProductTitle(product: odoo.OdooProduct): string {
  if (product.seo_name && typeof product.seo_name === 'string' && product.seo_name.trim()) {
    return product.seo_name.trim();
  }
  return cleanName(product.name);
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
  const title = getProductTitle(odooProduct);

  if (imageUrls.mainUrl) {
    attrs.push({ remote_url: imageUrls.mainUrl, position: 1, alt: title });
  }
  for (const extra of imageUrls.additionalUrls) {
    attrs.push({ remote_url: extra.url, position: extra.position, alt: title });
  }
  return attrs;
}

// ─── Payload Builder: FULL OVERWRITE ───────────────────────────
// Used for CREATE and for Actualizar SKU (forced overwrite).

function buildFullPayload(
  odooProduct: odoo.OdooProduct,
  includeImages: boolean = true,
): sellibri.SellibriProductPayload {
  const price = getSellibriPrice(odooProduct);
  const description = odooProduct.website_description || odooProduct.description_sale || '';
  const categId = Array.isArray(odooProduct.categ_id) ? odooProduct.categ_id[0] : 0;
  const taxonId = mapCategory(categId);
  const vendorId = mapBrandToVendor(odooProduct.brand_id);
  const title = getProductTitle(odooProduct);

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

// ─── Smart Diff: compare Odoo vs Sellibri, return payload ONLY if different ──
// Returns null if nothing changed (= skip the API call).
// Odoo is always master: when a field differs, the Odoo value wins.

function buildDiffPayload(
  odooProduct: odoo.OdooProduct,
  sp: sellibri.SellibriProduct,
): sellibri.SellibriProductPayload | null {
  const variant = sp.all_variants?.[0];
  if (!variant) return buildFullPayload(odooProduct, false); // no variant = broken, overwrite

  const odooPrice = getSellibriPrice(odooProduct);
  const odooStock = Math.max(0, Math.floor(odooProduct.qty_available || 0));
  const odooTitle = getProductTitle(odooProduct);
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

  // Status: must be active
  if (sp.status !== 'active') {
    needsUpdate = true;
  }

  // Title (Odoo is master)
  if ((sp.title || '') !== odooTitle) {
    productFields.title = odooTitle;
    needsUpdate = true;
  }

  // Price
  const currentPrice = parseFloat(variant.price || '0');
  const newPrice = parseFloat(odooPrice);
  if (Math.abs(currentPrice - newPrice) > 0.01) {
    masterAttrs.price = odooPrice;
    needsUpdate = true;
  }

  // Stock
  const currentStock = variant.stock_items?.[0]?.available ?? 0;
  if (currentStock !== odooStock) {
    masterAttrs.stock_items_attributes = [{
      stock_location_id: config.sellibri.stockLocationId,
      available: odooStock,
    }];
    needsUpdate = true;
  }

  // Category (only if Sellibri has none set)
  const currentTaxons = sp.taxon_ids || [];
  if (currentTaxons.length === 0) {
    productFields.taxon_ids = [taxonId];
    needsUpdate = true;
  }

  // Brand/Vendor
  if (vendorId && sp.product_vendor_id !== vendorId) {
    productFields.product_vendor_id = vendorId;
    needsUpdate = true;
  }

  // Barcode
  if (odooProduct.barcode && (variant.barcode || '') !== String(odooProduct.barcode)) {
    masterAttrs.barcode = odooProduct.barcode;
    needsUpdate = true;
  }

  // Weight
  const currentWeight = parseFloat(variant.weight || '0');
  if (odooProduct.weight && Math.abs(currentWeight - odooProduct.weight) > 0.01) {
    masterAttrs.weight = odooProduct.weight;
    needsUpdate = true;
  }

  // Images: add if Sellibri has none
  const sellibriImages = variant.images || [];
  if (sellibriImages.length === 0) {
    const imagesAttrs = buildImagesPayload(odooProduct);
    if (imagesAttrs.length > 0) {
      masterAttrs.images_attributes = imagesAttrs;
      needsUpdate = true;
    }
  }

  // Note: slug and description are NOT compared in diff.
  // - Slug: Sellibri auto-generates from title, ignores our value
  // - Description: HTML formatting differs between Odoo and Sellibri
  // Both are set correctly on CREATE (buildFullPayload).

  if (!needsUpdate) return null;

  return {
    product: {
      title: productFields.title || sp.title || odooTitle,
      status: 'active',
      ...(productFields.product_vendor_id ? { product_vendor_id: productFields.product_vendor_id } : {}),
      master_attributes: masterAttrs,
      taxon_ids: productFields.taxon_ids || sp.taxon_ids || [taxonId],
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// SYNC ESPEJO — Compare, correct, create, delete
// ═══════════════════════════════════════════════════════════════
//
// 1. Fetch ALL active products from Odoo
// 2. Fetch ALL products from Sellibri (catalog)
// 3. For each Odoo product:
//    - If in Sellibri → COMPARE field by field, PATCH only diffs
//    - If NOT in Sellibri → CREATE with full payload
// 4. For each Sellibri product NOT in Odoo → DELETE
//
// This is efficient: only products with actual differences
// generate API calls. Identical products are skipped.
// ═══════════════════════════════════════════════════════════════

export interface MirrorSyncResult {
  odooTotal: number;
  sellibriTotal: number;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  skippedInvalid: number;
  errors: number;
}

export async function syncMirror(): Promise<MirrorSyncResult> {
  if (mirrorSyncRunning || stockSyncRunning) {
    logger.warn(MODULE, 'Mirror sync: another sync is running, skipping');
    return { odooTotal: 0, sellibriTotal: 0, created: 0, updated: 0, unchanged: 0, deleted: 0, skippedInvalid: 0, errors: 0 };
  }
  mirrorSyncRunning = true;
  syncStatus.isRunning = true;
  syncStatus.lastError = null;

  const result: MirrorSyncResult = {
    odooTotal: 0, sellibriTotal: 0, created: 0, updated: 0,
    unchanged: 0, deleted: 0, skippedInvalid: 0, errors: 0,
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
          // ── EXISTS: compare field by field, only patch if different ──
          const diffPayload = buildDiffPayload(product, existing);

          if (diffPayload) {
            await sellibri.updateProduct(existing.id, diffPayload);
            result.updated++;
          } else {
            result.unchanged++;
          }

          state.products[sku] = {
            sellibriId: existing.id,
            sellibriVariantId: existing.all_variants?.[0]?.id || 0,
            odooWriteDate: product.write_date,
            lastSynced: new Date().toISOString(),
            lastStock: Math.max(0, Math.floor(product.qty_available || 0)),
            lastPrice: getSellibriPrice(product),
          };
        } else {
          // ── MISSING: create with full payload + images ──
          const payload = buildFullPayload(product, true);
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
        logger.info(MODULE, `Progress: ${processed}/${totalWork} (created=${result.created}, updated=${result.updated}, unchanged=${result.unchanged}, errors=${result.errors})`);
      }
    }

    // ── Phase 3: Delete everything in Sellibri that shouldn't exist ──
    //   a) Orphans: have SKU but SKU not in Odoo
    //   b) Duplicates: same SKU, multiple products
    //   c) No-SKU: products without any SKU (junk/legacy)
    if (!abortRequested) {
      const orphans: { sku: string; sellibriId: number }[] = [];
      const seenIds = new Set<number>();

      for (const [sku, product] of sellibriCatalog) {
        if (!odooSkuSet.has(sku) && !seenIds.has(product.id)) {
          orphans.push({ sku, sellibriId: product.id });
          seenIds.add(product.id);
        }
      }

      const duplicates = sellibri.getDuplicates();
      const noSkuIds = sellibri.getNoSkuProducts();

      const totalToDelete = orphans.length + duplicates.length + noSkuIds.length;

      if (totalToDelete > 0) {
        logger.info(MODULE, `To delete: ${orphans.length} orphans, ${duplicates.length} duplicates, ${noSkuIds.length} without SKU`);

        syncStatus.progress = {
          current: 0, total: totalToDelete,
          phase: `Eliminando ${totalToDelete} productos sobrantes...`,
          startedAt: syncStatus.progress?.startedAt || new Date().toISOString(),
          estimatedSecondsLeft: null,
        };

        const deleteStart = Date.now();
        let deleteIdx = 0;

        // Delete orphans (have SKU but not in Odoo)
        for (const orphan of orphans) {
          if (abortRequested) break;
          try {
            await sellibri.deleteProduct(orphan.sellibriId, orphan.sku);
            result.deleted++;
            delete state.products[orphan.sku];
          } catch (err: any) {
            result.errors++;
            logger.error(MODULE, `Delete orphan SKU=${orphan.sku}: ${err.message}`);
          }
          deleteIdx++;
          updateProgress(deleteIdx, totalToDelete, deleteStart, 'Eliminando:');
        }

        // Delete duplicates
        for (const dup of duplicates) {
          if (abortRequested) break;
          try {
            await sellibri.deleteProduct(dup.id, dup.sku);
            result.deleted++;
          } catch (err: any) {
            result.errors++;
            logger.error(MODULE, `Delete duplicate SKU=${dup.sku}: ${err.message}`);
          }
          deleteIdx++;
          updateProgress(deleteIdx, totalToDelete, deleteStart, 'Eliminando:');
        }

        // Delete products without SKU (junk/legacy)
        for (const id of noSkuIds) {
          if (abortRequested) break;
          try {
            await sellibri.deleteProduct(id);
            result.deleted++;
          } catch (err: any) {
            result.errors++;
            logger.error(MODULE, `Delete no-SKU id=${id}: ${err.message}`);
          }
          deleteIdx++;
          if (deleteIdx % 200 === 0) {
            updateProgress(deleteIdx, totalToDelete, deleteStart, 'Eliminando:');
            logger.info(MODULE, `Cleanup: ${deleteIdx}/${totalToDelete} (deleted=${result.deleted}, errors=${result.errors})`);
          } else {
            updateProgress(deleteIdx, totalToDelete, deleteStart, 'Eliminando:');
          }
        }

        sellibri.clearCleanupLists();
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
    logger.info(MODULE, `Mirror sync ${abortRequested ? 'ABORTED' : 'complete'} in ${totalTime}min: ${result.created} created, ${result.updated} corrected, ${result.unchanged} unchanged, ${result.deleted} deleted, ${result.skippedInvalid} invalid, ${result.errors} errors`);
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
// ACTUALIZAR SKU — Delete + recreate from Odoo (clean slate)
// ═══════════════════════════════════════════════════════════════
// Strategy: always delete existing + create fresh.
// This avoids image duplication and stale data issues.
// Also fetches the real title from the Odoo website (og:title)
// to handle products created via "Duplicate" where the API
// name field keeps the old product's name.

export async function syncSingleSku(sku: string): Promise<{ success: boolean; message: string }> {
  logger.info(MODULE, `Actualizar SKU=${sku}...`);

  try {
    // 1. Fetch product from Odoo
    const odooProduct = await odoo.fetchProductBySku(sku);
    if (!odooProduct) {
      return { success: false, message: `SKU ${sku} no encontrado en Odoo` };
    }

    if (!isValidForSellibri(odooProduct)) {
      return { success: false, message: `SKU ${sku} no tiene datos válidos (precio=0 o sin nombre)` };
    }

    // 2. Try to get the real title from the Odoo website
    //    (handles duplicated products where 'name' has the old product's name)
    let title = getProductTitle(odooProduct);
    const tmplId = Array.isArray(odooProduct.product_tmpl_id) ? odooProduct.product_tmpl_id[0] : 0;
    if (tmplId) {
      const webTitle = await odoo.fetchWebTitle(tmplId);
      if (webTitle) {
        title = webTitle;
        logger.info(MODULE, `SKU=${sku}: using web title "${title}"`);
      }
    }

    // 3. Delete existing product in Sellibri (if any)
    const catalog = await sellibri.getCatalog();
    let existingProduct = catalog.get(sku) || null;

    // Also check state for stale references
    if (!existingProduct) {
      const st = loadState();
      const cached = st.products[sku];
      if (cached?.sellibriId) {
        try {
          const fetched = await sellibri.fetchProductById(cached.sellibriId);
          if (fetched) existingProduct = fetched;
        } catch {
          // Product doesn't exist, that's fine
        }
      }
    }

    if (existingProduct) {
      logger.info(MODULE, `SKU=${sku}: deleting existing id=${existingProduct.id}`);
      await sellibri.deleteProduct(existingProduct.id, sku);
    }

    // 4. Create fresh product with correct title + images
    const payload = buildFullPayload(odooProduct, true);
    // Override the title with the web-sourced title
    payload.product.title = title;

    const newProduct = await sellibri.createProduct(payload);
    const sellibriId = newProduct.id;
    const variantId = newProduct.all_variants?.[0]?.id || 0;
    logger.info(MODULE, `SKU=${sku}: created id=${sellibriId} title="${title}"`);

    // 5. Update state
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

    const imagesCount = (newProduct.all_variants?.[0]?.images || []).length;
    return {
      success: true,
      message: `SKU ${sku} ${existingProduct ? 'recreado' : 'creado'} — "${title}"${imagesCount > 0 ? ` + ${imagesCount} imágenes` : ''}`,
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
