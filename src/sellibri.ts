import * as fs from 'fs';
import * as path from 'path';
import * as odoo from './odoo';
import * as sellibri from './sellibri';
import { config } from './config';
import { mapCategory, buildCategoryMap } from './category-map';
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
//    precio, stock, categoría, marca, imágenes, peso)
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

// ─── Sync Progress & Status ───────────────────────────────────────────

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

// ─── Helpers ───────────────────────────────────────────────

/**
 * Remove Odoo's copy/duplicate markers AND trailing variant attribute suffixes
 * from a product name.
 * Examples:
 *   "Cable UTP (copia)"      → "Cable UTP"
 *   "Cable UTP (Azul)"       → "Cable UTP" (only if it's the last parenthesized group)
 *   "[XTA150] Xtech - Base (copiar 2)" → "[XTA150] Xtech - Base"
 */
function cleanName(name: string): string {
  if (!name) return name;
  let cleaned = name
    // Remove (copia), (copiar), (copiar 2), (copy), (copy 3), etc.
    .replace(/\s*\(copia[r]?(\s*\d*)?\)/gi, '')
    .replace(/\s*\(copy(\s*\d*)?\)/gi, '')
    .trim();
  return cleaned;
}

/**
 * Get the CORRECT title for a product.
 * 
 * Strategy: Try product.template name first (handles most cases correctly).
 * If template name matches another product's name (variant confusion),
 * fall back to product.product.name.
 * 
 * Both sources get cleaned of (copia)/(copy) markers.
 */
async function getProductTitle(product: odoo.OdooProduct): Promise<string> {
  // Primary: read from product.template — this is what Odoo's UI shows
  if (product.product_tmpl_id && Array.isArray(product.product_tmpl_id)) {
    const tmplName = await odoo.fetchTemplateName(product.product_tmpl_id[0]);
    if (tmplName) return cleanName(tmplName);
  }
  // Fallback: product.product.name (may have variant suffix)
  return cleanName(product.name);
}

/**
 * Extract a clean text description from Odoo's HTML or plain text fields.
 * Strips HTML tags for a clean Sellibri description.
 */
function getDescription(product: odoo.OdooProduct): string {
  const raw = product.website_description || product.description_sale || '';
  if (typeof raw !== 'string') return '';
  // Strip HTML tags if present, keep text content
  return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
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

// ─── Image Builder ─────────────────────────────────────────────────

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

// ─── Payload Builder: FULL OVERWRITE ─────────────────────────────

async function buildFullPayload(
  odooProduct: odoo.OdooProduct,
  includeImages: boolean = true,
): Promise<sellibri.SellibriProductPayload> {
  const price = getSellibriPrice(odooProduct);
  const description = getDescription(odooProduct);
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
      available: Math.max(0, Math.floor(odooProduct.qty_available || 0)),
    }],
  };

  if (includeImages) {
    const imagesAttrs = buildImagesPayload(odooProduct, title);
    if (imagesAttrs.length > 0) {
      masterAttrs.images_attributes = imagesAttrs;
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

// ─── Smart Diff ────────────────────────────────────────────────────

async function buildDiffPayload(
  odooProduct: odoo.OdooProduct,
  sp: sellibri.SellibriProduct,
): Promise<sellibri.SellibriProductPayload | null> {
  const variant = sp.all_variants?.[0];
  if (!variant) return await buildFullPayload(odooProduct, false);

  const odooPrice = getSellibriPrice(odooProduct);
  const odooStock = Math.max(0, Math.floor(odooProduct.qty_available || 0));
  const odooTitle = await getProductTitle(odooProduct);
  const odooDescription = getDescription(odooProduct);
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

  // Status
  if (sp.status !== 'active') { needsUpdate = true; }

  // Title
  if ((sp.title || '') !== odooTitle) {
    productFields.title = odooTitle;
    needsUpdate = true;
  }

  // Description — compare and sync
  const currentDescription = sp.description || '';
  if (odooDescription && currentDescription !== odooDescription) {
    productFields.description = odooDescription;
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

  // Category (taxon_ids) — always compare and update
  const currentTaxons = sp.taxon_ids || [];
  if (!currentTaxons.includes(taxonId)) {
    productFields.taxon_ids = [taxonId];
    needsUpdate = true;
  }

  // Vendor (brand)
  if (vendorId && sp.product_vendor_id !== vendorId) {
    productFields.product_vendor_id = vendorId;
    needsUpdate = true;
