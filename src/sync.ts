import * as fs from 'fs';
import * as path from 'path';
import * as odoo from './odoo';
import * as sellibri from './sellibri';
import { config } from './config';
import { mapCategory, buildCategoryMap } from './category-map';
import { mapBrandToVendor } from './brand-map';
import { logger } from './logger';

const MODULE = 'sync';

export function getProtectedSkus(): string[] {
  return config.deleteProtectionSkus;
}

export function addProtectedSku(sku: string): void {
  if (!config.deleteProtectionSkus.includes(sku)) {
    config.deleteProtectionSkus.push(sku);
    logger.info(MODULE, `Added SKU=${sku} to protection whitelist`);
  }
}

export function removeProtectedSku(sku: string): void {
  const idx = config.deleteProtectionSkus.indexOf(sku);
  if (idx >= 0) {
    config.deleteProtectionSkus.splice(idx, 1);
    logger.info(MODULE, `Removed SKU=${sku} from protection whitelist`);
  }
}
const STATE_FILE = path.join(process.cwd(), 'sync-state.json');

// ===============================================================
// ARCHITECTURE: Odoo es MASTER -- Sellibri es ESPEJO
// ===============================================================
//
// Principios:
// 1. Todo lo que esta en Odoo (activo, vendible, con SKU) DEBE estar en Sellibri
// 2. Todo campo se sobreescribe con el valor de Odoo (titulo, descripcion,
//    precio, stock, categoria, marca, imagenes, peso)
// 3. Productos archivados/inactivos en Odoo -> se eliminan de Sellibri
// 4. Productos en Sellibri sin SKU en Odoo -> se eliminan de Sellibri
// 5. SKU (default_code en Odoo) = factor comparativo
//
// Flujos:
// - Sync Espejo (cron 1h + boton): comparacion completa Odoo vs Sellibri
// - Actualizar SKU (boton): overwrite completo de un solo producto
// - Precio/Stock (cron 15min + boton): solo precio y stock rapido
// ===============================================================

interface ProductSyncEntry {
  sellibriId: number;
  sellibriVariantId: number;
  odooWriteDate: string;
  lastSynced: string;
  lastStock?: number;
  lastPrice?: string;
  missingSince?: string;
  missingCount?: number;
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

// --- Sync Progress & Status ---

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
  logger.warn(MODULE, 'Abort requested -- sync will stop after current product');
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
    logger.warn(MODULE, 'Sync state cleared -- next sync will start from scratch');
  } catch (err: any) {
    logger.error(MODULE, `Could not clear sync state: ${err.message}`);
  }
}

// --- Helpers ---

function normalizeSpecialChars(name: string): string {
  if (!name) return name;
  return name
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&iexcl;/g, '¡')
    .replace(/&iquest;/g, '¿')
    .replace(/&copy;/g, '(C)')
    .replace(/&reg;/g, '(R)')
    .replace(/&trade;/g, '(TM)')
    .replace(/&deg;/g, ' grados')
    .replace(/&ntilde;/g, 'ñ')
    .replace(/&Ntilde;/g, 'Ñ')
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/&Aacute;/g, 'Á')
    .replace(/&Eacute;/g, 'É')
    .replace(/&Iacute;/g, 'Í')
    .replace(/&Oacute;/g, 'Ó')
    .replace(/&Uacute;/g, 'Ú')
    .replace(/\u00F1/g, 'ñ')
    .replace(/\u00D1/g, 'Ñ');
}

function cleanName(name: string): string {
  if (!name) return name;
  return normalizeSpecialChars(
    name
      .replace(/\s*\(copia[r]?(\s*\d*)?\)/gi, '')
      .replace(/\s*\(copy(\s*\d*)?\)/gi, '')
      .trim()
  );
}

async function getProductTitle(product: odoo.OdooProduct): Promise<string> {
  if (product.product_tmpl_id && Array.isArray(product.product_tmpl_id)) {
    const tmplName = await odoo.fetchTemplateName(product.product_tmpl_id[0], product.default_code);
    logger.info(MODULE, `Title diagnostics SKU=${product.default_code}: product.name="${product.name}", tmplName="${tmplName}"`);
    if (tmplName) return cleanName(tmplName);
  }
  return cleanName(product.name);
}

async function getDescription(product: odoo.OdooProduct): Promise<string> {
  // Try to get website_description from template first (correct for duplicated products)
  let raw = '';
  if (product.product_tmpl_id && Array.isArray(product.product_tmpl_id)) {
    const tmplDesc = await odoo.fetchTemplateDescription(product.product_tmpl_id[0]);
    if (tmplDesc) raw = tmplDesc;
  }
  // Fallback to product fields
  if (!raw) {
    raw = product.website_description || product.description_sale || '';
  }
  if (typeof raw !== 'string') return '';
  // Preserve HTML formatting but normalize special chars
  return normalizeSpecialChars(raw.trim());
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

function isValidForSellibri(product: odoo.OdooProduct): boolean {
  if (!product.default_code || product.default_code.trim() === '') return false;
  const price = parseFloat(getSellibriPrice(product));
  if (isNaN(price) || price <= 0) return false;
  return true;
}

// --- Image Builder ---

function buildImagesPayload(odooProduct: odoo.OdooProduct, title: string): sellibri.SellibriImageAttribute[] {
  const imageUrls = odoo.buildImageUrls(odooProduct);
  const attrs: sellibri.SellibriImageAttribute[] = [];
  if (imageUrls.mainUrl) {
    attrs.push({ remote_url: imageUrls.mainUrl, position: 1, alt: title });
  }
  for (const extra of imageUrls.additionalUrls) {
    attrs.push({ remote_url: extra.url, position: extra.position, alt: title });
  }
  return attrs;
}

// --- Payload Builder: FULL OVERWRITE ---

async function buildFullPayload(
  odooProduct: odoo.OdooProduct,
  includeImages: boolean = true,
): Promise<sellibri.SellibriProductPayload> {
  const price = getSellibriPrice(odooProduct);
    const description = await getDescription(odooProduct);
  const categId = Array.isArray(odooProduct.categ_id) ? odooProduct.categ_id[0] : 0;
  const taxonId = mapCategory(categId);
  const vendorId = mapBrandToVendor(odooProduct.brand_id);
  const title = await getProductTitle(odooProduct);

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
      available: Math.max(0, Math.floor((odooProduct.virtual_available !== undefined ? odooProduct.virtual_available : odooProduct.qty_available) || 0)),
    }],
  };
  
  logger.info(MODULE, `buildFullPayload SKU=${odooProduct.default_code}: qty_available=${odooProduct.qty_available}, virtual_available=${odooProduct.virtual_available}, sending available=${Math.max(0, Math.floor((odooProduct.virtual_available !== undefined ? odooProduct.virtual_available : odooProduct.qty_available) || 0))}`);

  if (includeImages) {
    const imagesAttrs = buildImagesPayload(odooProduct, title);
    logger.info(MODULE, `buildFullPayload SKU=${odooProduct.default_code}: has_main_image=${imagesAttrs.length > 0 && !!imagesAttrs[0]?.remote_url?.includes('_main.jpg')}`);
    if (imagesAttrs.length > 0) {
      masterAttrs.images_attributes = imagesAttrs;
      logger.info(MODULE, `buildFullPayload SKU=${odooProduct.default_code}: Sending ${imagesAttrs.length} images (main: ${imagesAttrs[0]?.remote_url})`);
    } else {
      logger.info(MODULE, `buildFullPayload SKU=${odooProduct.default_code}: No images to send`);
    }
  }

  return {
    product: {
      title,
      slug: odooProduct.default_code,
      status: 'active',
      description,
      ...(vendorId ? { product_vendor_id: vendorId } : {}),
      master_attributes: masterAttrs,
      taxon_ids: [taxonId],
    },
  };
}

// --- Smart Diff ---

async function buildDiffPayload(
  odooProduct: odoo.OdooProduct,
  sp: sellibri.SellibriProduct,
): Promise<sellibri.SellibriProductPayload | null> {
  const variant = sp.all_variants?.[0];
  if (!variant) return await buildFullPayload(odooProduct, false);

  const odooPrice = getSellibriPrice(odooProduct);
  const odooStock = Math.max(0, Math.floor(odooProduct.virtual_available || odooProduct.qty_available || 0));
  const odooTitle = await getProductTitle(odooProduct);
    const odooDescription = await getDescription(odooProduct);
  const categId = Array.isArray(odooProduct.categ_id) ? odooProduct.categ_id[0] : 0;
  const taxonId = mapCategory(categId);
  const vendorId = mapBrandToVendor(odooProduct.brand_id);

  let needsUpdate = false;
  const diffReasons: string[] = [];
  const productFields: Record<string, any> = {};
  const masterAttrs: sellibri.SellibriMasterAttributes = {
    sku: odooProduct.default_code,
    track_inventory: true,
    tax_rate_id: config.sellibri.taxRateId,
  };

  if (sp.status !== 'active') { needsUpdate = true; diffReasons.push('status'); }

  if ((sp.title || '') !== odooTitle) {
    productFields.title = odooTitle;
    needsUpdate = true;
    diffReasons.push('title');
  }

  // Description diff
  const currentDescription = sp.description || '';
  if (odooDescription && currentDescription !== odooDescription) {
    productFields.description = odooDescription;
    needsUpdate = true;
    diffReasons.push('description');
  }

  const currentPrice = parseFloat(variant.price || '0');
  const newPrice = parseFloat(odooPrice);
  if (Math.abs(currentPrice - newPrice) > 0.01) {
    masterAttrs.price = odooPrice;
    needsUpdate = true;
    diffReasons.push('price');
  }

  const currentStock = variant.stock_items?.[0]?.available ?? 0;
  if (currentStock !== odooStock) {
    masterAttrs.stock_items_attributes = [{
      stock_location_id: config.sellibri.stockLocationId,
      available: odooStock,
    }];
    needsUpdate = true;
    diffReasons.push('stock');
  }

  // Category diff - always compare
  if (sp.taxon_ids !== undefined) {
    const currentTaxons = sp.taxon_ids;
    if (!currentTaxons.includes(taxonId)) {
      productFields.taxon_ids = [taxonId];
      needsUpdate = true;
      diffReasons.push('taxon_ids');
    }
  }

  if (vendorId && sp.product_vendor_id !== vendorId) {
    productFields.product_vendor_id = vendorId;
    needsUpdate = true;
    diffReasons.push('vendor_id');
  }

  if (odooProduct.barcode && (variant.barcode || '') !== String(odooProduct.barcode)) {
    masterAttrs.barcode = odooProduct.barcode;
    needsUpdate = true;
    diffReasons.push('barcode');
  }

  // Weight diff
  const currentWeight = parseFloat(variant.weight || '0');
  if (odooProduct.weight && Math.abs(currentWeight - odooProduct.weight) > 0.01) {
    masterAttrs.weight = odooProduct.weight;
    needsUpdate = true;
    diffReasons.push('weight');
  }

  const sellibriImages = variant.images || [];
  const firstImageUrl = sellibriImages.length > 0 ? (sellibriImages[0].url || '').toLowerCase() : '';
  const isFirstImageInvalid = firstImageUrl.includes('missing') || 
                              firstImageUrl.includes('default') || 
                              firstImageUrl.includes('fallback') || 
                              firstImageUrl.includes('placeholder') ||
                              firstImageUrl === '';

  if (sellibriImages.length === 0 || isFirstImageInvalid) {
    const imagesAttrs = buildImagesPayload(odooProduct, odooTitle);
    if (imagesAttrs.length > 0) {
      masterAttrs.images_attributes = imagesAttrs;
      needsUpdate = true;
      diffReasons.push('images');
    }
  }

  if (!needsUpdate) return null;
  
  if (diffReasons.length > 0) {
    logger.info(MODULE, `Diff payload built for ${odooProduct.default_code}, reasons: ${diffReasons.join(', ')}`);
  }

  return {
    product: {
      title: productFields.title || sp.title || odooTitle,
      status: 'active',
      ...(productFields.description !== undefined ? { description: productFields.description } : {}),
      ...(productFields.product_vendor_id ? { product_vendor_id: productFields.product_vendor_id } : {}),
      master_attributes: masterAttrs,
      taxon_ids: productFields.taxon_ids || sp.taxon_ids || [taxonId],
    },
  };
}

// ===============================================================
// SYNC ESPEJO
// ===============================================================

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
  // Mirror sync has PRIORITY - can run even if stock sync is running
  if (mirrorSyncRunning) {
    logger.warn(MODULE, 'Mirror sync already running, skipping');
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
    syncStatus.progress = {
      current: 0, total: 0,
      phase: 'Espejo: cargando catalogos Odoo + Sellibri...',
      startedAt: new Date().toISOString(),
      estimatedSecondsLeft: null,
    };

    logger.info(MODULE, 'Mirror sync: loading Odoo products...');
    odoo.clearTemplateCache();
    const odooProducts = await odoo.fetchAllProducts();
    result.odooTotal = odooProducts.length;

    logger.info(MODULE, 'Mirror sync: building category map...');
    const odooCategories = await odoo.fetchActiveCategories();
    await buildCategoryMap(odooCategories);

    logger.info(MODULE, 'Mirror sync: loading Sellibri catalog...');
    const sellibriCatalog = await sellibri.getCatalog(true);
    result.sellibriTotal = sellibriCatalog.size;

    const odooSkuSet = new Set<string>();
    for (const p of odooProducts) {
      if (p.default_code) odooSkuSet.add(p.default_code);
    }

    logger.info(MODULE, `Mirror sync: Odoo=${odooProducts.length} products (${odooSkuSet.size} unique SKUs), Sellibri=${sellibriCatalog.size}`);

    const totalWork = odooProducts.length;
    const batchStartTime = Date.now();
    let processed = 0;

    const concurrency = 3;
    const workers = Array.from({ length: concurrency }, async () => {
      while (odooProducts.length > 0 && !abortRequested) {
        const product = odooProducts.shift()!;
        const sku = product.default_code;
        if (!sku) { processed++; continue; }

        if (!isValidForSellibri(product)) {
          const price = product.price_with_tax || product.list_price;
          const priceWithTax = product.price_with_tax;
          const listPrice = product.list_price;
          logger.warn(MODULE, `SKU=${sku}: skipped invalid -- price_with_tax=${priceWithTax}, list_price=${listPrice}, effective_price=${price}, has_name=${product.name ? 'yes' : 'no'}`);
          result.skippedInvalid++;
          processed++;
          updateProgress(processed, totalWork, batchStartTime, 'Espejo:');
          continue;
        }

        try {
          const existing = sellibriCatalog.get(sku);
          if (existing) {
            const diffPayload = await buildDiffPayload(product, existing);
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
              lastStock: Math.max(0, Math.floor(product.virtual_available || product.qty_available || 0)),
              lastPrice: getSellibriPrice(product),
            };
          } else {
            const payload = await buildFullPayload(product, true);
            logger.info(MODULE, `Creating SKU=${sku} title="${payload.product.title}" price=${payload.product.master_attributes?.price} stock=${payload.product.master_attributes?.stock_items_attributes?.[0]?.available}`);
            const newProduct = await sellibri.createProduct(payload);
            result.created++;
            logger.info(MODULE, `Created SKU=${sku} (id=${newProduct.id})`);
            state.products[sku] = {
              sellibriId: newProduct.id,
              sellibriVariantId: newProduct.all_variants?.[0]?.id || 0,
              odooWriteDate: product.write_date,
              lastSynced: new Date().toISOString(),
              lastStock: Math.max(0, Math.floor(product.virtual_available || product.qty_available || 0)),
              lastPrice: getSellibriPrice(product),
            };
          }
        } catch (err: any) {
          result.errors++;
          const status = (err as any)?.response?.status;
          const errData = (err as any)?.response?.data;
          if (status === 400) {
            logger.warn(MODULE, `SKU=${sku}: 400 Bad Request (skipped) - ${JSON.stringify(errData)?.substring(0, 500)}`);
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
    });

    await Promise.all(workers);

    // Phase 3: Delete orphans
    // Only delete products that are NOT in Odoo AND were never synced before
    let verifiedOdooSkuSet: Set<string> | null = null;
    if (!abortRequested) {
      const orphans: { sku: string; sellibriId: number }[] = [];
      const seenIds = new Set<number>();
      const protectedSkus = new Set(config.deleteProtectionSkus);
      
      // Fallback verification: fetch all active SKUs from Odoo to confirm which products truly exist.
      // This catches products that might be missed by fetchAllProducts() due to pagination or filtering issues.
      logger.info(MODULE, 'Mirror sync: verifying SKU existence with lightweight Odoo query...');
      const odooActiveSkus = await odoo.fetchAllActiveSKUs();
      verifiedOdooSkuSet = new Set<string>([...odooSkuSet, ...odooActiveSkus]);
      const extraSkusFound = [...odooActiveSkus].filter(s => !odooSkuSet.has(s));
      if (extraSkusFound.length > 0) {
        logger.warn(MODULE, `Found ${extraSkusFound.length} SKUs in Odoo that were missed by full product fetch (e.g., ${extraSkusFound.slice(0, 5).join(', ')})`);
        
        // Phase 3.5: Sync the missed products by fetching them individually
        logger.info(MODULE, `Syncing ${extraSkusFound.length} missed products individually...`);
        syncStatus.progress = {
          current: 0, total: extraSkusFound.length,
          phase: `Sincronizando ${extraSkusFound.length} productos perdidos...`,
          startedAt: syncStatus.progress?.startedAt || new Date().toISOString(),
          estimatedSecondsLeft: null,
        };
        
        let syncedMissed = 0;
        for (let i = 0; i < extraSkusFound.length; i++) {
          if (abortRequested) break;
          const missedSku = extraSkusFound[i];
          try {
            const missedProduct = await odoo.fetchProductBySku(missedSku);
            if (!missedProduct || !isValidForSellibri(missedProduct)) {
              logger.warn(MODULE, `Missed SKU=${missedSku}: invalid or not found individually`);
              continue;
            }
            
            const existing = sellibriCatalog.get(missedSku);
            if (existing) {
              const diffPayload = await buildDiffPayload(missedProduct, existing);
              if (diffPayload) {
                await sellibri.updateProduct(existing.id, diffPayload);
                result.updated++;
              } else {
                result.unchanged++;
              }
            } else {
              const payload = await buildFullPayload(missedProduct, true);
              const newProduct = await sellibri.createProduct(payload);
              result.created++;
              logger.info(MODULE, `Created missed SKU=${missedSku} (id=${newProduct.id})`);
              sellibriCatalog.set(missedSku, newProduct);
            }
            
            state.products[missedSku] = {
              sellibriId: existing?.id || (await sellibri.getCatalog()).get(missedSku)?.id || 0,
              sellibriVariantId: 0,
              odooWriteDate: missedProduct.write_date,
              lastSynced: new Date().toISOString(),
              lastStock: Math.max(0, Math.floor(missedProduct.virtual_available || missedProduct.qty_available || 0)),
              lastPrice: getSellibriPrice(missedProduct),
            };
            syncedMissed++;
          } catch (err: any) {
            result.errors++;
            logger.error(MODULE, `Error syncing missed SKU=${missedSku}: ${err.message}`);
          }
          
          updateProgress(i + 1, extraSkusFound.length, Date.now(), 'Sincronizando perdidos:');
          if ((i + 1) % 50 === 0) {
            saveState(state);
            logger.info(MODULE, `Missed products: ${i + 1}/${extraSkusFound.length} (synced=${syncedMissed}, errors=${result.errors})`);
          }
        }
        logger.info(MODULE, `Missed products sync complete: ${syncedMissed} synced, ${extraSkusFound.length - syncedMissed} failed/skipped`);
      }
      
      for (const [sku, product] of sellibriCatalog) {
        if (!verifiedOdooSkuSet.has(sku) && !seenIds.has(product.id)) {
          // Don't delete products that were previously synced (might be in Odoo but filtered out)
          const previouslySynced = state.products[sku];
          if (previouslySynced) {
            logger.warn(MODULE, `Keeping previously synced SKU=${sku} (not in current Odoo fetch but was synced before)`);
            continue;
          }
          // Don't delete products that are in the protection whitelist
          if (protectedSkus.has(sku)) {
            logger.warn(MODULE, `Keeping protected SKU=${sku} (in DELETE_PROTECTION_SKUS whitelist)`);
            continue;
          }
          orphans.push({ sku, sellibriId: product.id });
          seenIds.add(product.id);
          logger.info(MODULE, `Orphan identified: SKU=${sku} id=${product.id} title="${product.title}"`);
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

    state.lastMirrorSync = new Date().toISOString();
    // Grace period: don't immediately remove products from state if missing from Odoo fetch.
    // Products are only removed after 3 consecutive syncs where they're not found.
    // This protects against intermittent Odoo API issues, pagination race conditions,
    // or temporary filtering problems (e.g., BOM components, price=0 products).
    const gracePeriodSyncs = 3;
    // Use verifiedOdooSkuSet for state cleanup (includes fallback SKU verification), fallback to odooSkuSet if abort was requested
    const cleanupSkuSet = verifiedOdooSkuSet || odooSkuSet;
    for (const sku of Object.keys(state.products)) {
      if (!cleanupSkuSet.has(sku)) {
        const entry = state.products[sku];
        if (!entry.missingSince) {
          entry.missingSince = new Date().toISOString();
          entry.missingCount = 1;
          logger.warn(MODULE, `SKU=${sku}: not in Odoo fetch, marking as missing (1/${gracePeriodSyncs})`);
        } else {
          entry.missingCount = (entry.missingCount || 0) + 1;
          if (entry.missingCount >= gracePeriodSyncs) {
            logger.warn(MODULE, `SKU=${sku}: missing for ${gracePeriodSyncs} consecutive syncs, removing from state`);
            delete state.products[sku];
          } else {
            logger.warn(MODULE, `SKU=${sku}: still missing (${entry.missingCount}/${gracePeriodSyncs}), keeping in state`);
          }
        }
      } else {
        // Product found again, reset missing tracking
        const entry = state.products[sku];
        if (entry.missingSince) {
          logger.info(MODULE, `SKU=${sku}: found in Odoo fetch again, resetting missing tracking`);
          delete entry.missingSince;
          delete entry.missingCount;
        }
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

// ===============================================================
// ACTUALIZAR SKU -- Delete + recreate from Odoo (clean slate)
// ===============================================================

export async function syncSingleSku(sku: string): Promise<{ success: boolean; message: string }> {
  logger.info(MODULE, `Actualizar SKU=${sku}...`);
  try {
    const odooProduct = await odoo.fetchProductBySku(sku);
        logger.info(MODULE, `SKU=${sku} DIAG: id=${odooProduct?.id}, name="${odooProduct?.name}", tmpl_id=${JSON.stringify(odooProduct?.product_tmpl_id)}, categ=${JSON.stringify(odooProduct?.categ_id)}`);
    if (!odooProduct) {
      return { success: false, message: `SKU ${sku} no encontrado en Odoo` };
    }
    if (!isValidForSellibri(odooProduct)) {
      return { success: false, message: `SKU ${sku} no tiene datos validos (precio=0 o sin nombre)` };
    }

    const odooCategories = await odoo.fetchActiveCategories();
    await buildCategoryMap(odooCategories);

    const title = await getProductTitle(odooProduct);
        logger.info(MODULE, `SKU=${sku} DIAG: resolved title="${title}"`);

    const catalog = await sellibri.getCatalog();
    let existingProduct = catalog.get(sku) || null;

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

    const payload = await buildFullPayload(odooProduct, true);
    payload.product.title = title;
    const newProduct = await sellibri.createProduct(payload);
    const sellibriId = newProduct.id;
    const variantId = newProduct.all_variants?.[0]?.id || 0;

    logger.info(MODULE, `SKU=${sku}: created id=${sellibriId} title="${title}"`);

    const state = loadState();
    state.products[sku] = {
      sellibriId,
      sellibriVariantId: variantId,
      odooWriteDate: odooProduct.write_date,
      lastSynced: new Date().toISOString(),
      lastStock: Math.max(0, Math.floor(odooProduct.virtual_available || odooProduct.qty_available || 0)),
      lastPrice: getSellibriPrice(odooProduct),
    };
    saveState(state);

    const imagesCount = (newProduct.all_variants?.[0]?.images || []).length;
    return {
      success: true,
      message: `SKU ${sku} ${existingProduct ? 'recreado' : 'creado'} -- "${title}"${imagesCount > 0 ? ` + ${imagesCount} imagenes` : ''}`,
    };
  } catch (err: any) {
    logger.error(MODULE, `Actualizar SKU=${sku} failed: ${err.message}`);
    return { success: false, message: err.message };
  }
}

export async function restoreProduct(sku: string): Promise<{ success: boolean; message: string }> {
  logger.info(MODULE, `Restaurar SKU=${sku}...`);
  try {
    const odooProduct = await odoo.fetchProductBySku(sku);
    if (!odooProduct) {
      return { success: false, message: `SKU ${sku} no encontrado en Odoo` };
    }
    if (!isValidForSellibri(odooProduct)) {
      return { success: false, message: `SKU ${sku} no tiene datos validos (precio=0 o sin nombre)` };
    }

    const catalog = await sellibri.getCatalog();
    const existingProduct = catalog.get(sku);
    if (existingProduct) {
      return { success: false, message: `SKU ${sku} ya existe en Sellibri (id=${existingProduct.id})` };
    }

    const odooCategories = await odoo.fetchActiveCategories();
    await buildCategoryMap(odooCategories);

    const payload = await buildFullPayload(odooProduct, true);
    const title = await getProductTitle(odooProduct);
    payload.product.title = title;
    
    const newProduct = await sellibri.createProduct(payload);
    const sellibriId = newProduct.id;
    const variantId = newProduct.all_variants?.[0]?.id || 0;

    logger.info(MODULE, `SKU=${sku}: restored id=${sellibriId} title="${title}"`);

    const state = loadState();
    state.products[sku] = {
      sellibriId,
      sellibriVariantId: variantId,
      odooWriteDate: odooProduct.write_date,
      lastSynced: new Date().toISOString(),
      lastStock: Math.max(0, Math.floor(odooProduct.virtual_available || odooProduct.qty_available || 0)),
      lastPrice: getSellibriPrice(odooProduct),
    };
    saveState(state);

    const imagesCount = (newProduct.all_variants?.[0]?.images || []).length;
    return {
      success: true,
      message: `SKU ${sku} restaurado -- "${title}"${imagesCount > 0 ? ` + ${imagesCount} imagenes` : ''}`,
    };
  } catch (err: any) {
    logger.error(MODULE, `Restaurar SKU=${sku} failed: ${err.message}`);
    return { success: false, message: err.message };
  }
}

// ===============================================================
// PRECIO/STOCK -- Fast sync (cron 15min + manual button)
// ===============================================================

export async function syncPriceStock(): Promise<void> {
  // Price/Stock sync can be running concurrently with mirror
  // But skip if:
  // 1. Already running price/stock sync
  // 2. Mirror sync is running (mirror has priority)
  if (stockSyncRunning) {
    logger.warn(MODULE, 'Price/Stock sync already running, skipping');
    return;
  }
  if (mirrorSyncRunning) {
    logger.warn(MODULE, 'Mirror sync running - price/stock sync skipped (mirror has priority)');
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
          qty: Math.max(0, Math.floor((p.virtual_available !== undefined ? p.virtual_available : p.qty_available) || 0)),
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
