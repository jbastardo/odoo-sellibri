import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from './config';
import { logger } from './logger';

const MODULE = 'sellibri';

// --- Adaptive Rate Limiter ---
// Aggressive: 3 req/sec steady, global cooldown on 429

class AdaptiveRateLimiter {
  private lastRequestTime = 0;
  private minInterval = 350; // 350ms = ~2.8 req/sec (under 4/sec limit with margin)
  private cooldownUntil = 0;
  private consecutiveSuccesses = 0;

  async waitForSlot(): Promise<void> {
    const now = Date.now();
    if (this.cooldownUntil > now) {
      const waitMs = this.cooldownUntil - now;
      logger.warn(MODULE, `Cooldown active, waiting ${Math.round(waitMs / 1000)}s`);
      await this.delay(waitMs);
    }

    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      await this.delay(this.minInterval - elapsed);
    }

    this.lastRequestTime = Date.now();
  }

  reportSuccess(): void {
    this.consecutiveSuccesses++;
    // Speed up after 50 consecutive successes (reduce to 300ms)
    if (this.consecutiveSuccesses > 50 && this.minInterval > 300) {
      this.minInterval = 300;
    }
  }

  triggerCooldown(durationMs: number): void {
    this.consecutiveSuccesses = 0;
    this.minInterval = 500; // Slow down after a 429
    const newCooldown = Date.now() + durationMs;
    if (newCooldown > this.cooldownUntil) {
      this.cooldownUntil = newCooldown;
      logger.warn(MODULE, `429 -- cooldown ${Math.round(durationMs / 1000)}s`);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

const rateLimiter = new AdaptiveRateLimiter();

const client: AxiosInstance = axios.create({
  baseURL: config.sellibri.baseUrl,
  headers: {
    'X-Api-Key': config.sellibri.apiKey,
    'Content-Type': 'application/json',
  },
  timeout: 30_000,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

/** Retry wrapper with adaptive backoff on 429 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      rateLimiter.reportSuccess();
      return result;
    } catch (err: any) {
      const status = (err as AxiosError)?.response?.status;
      if (status === 429 && attempt < maxRetries) {
        const waitMs = Math.pow(2, attempt) * 30_000; // 30s, 60s, 120s
        rateLimiter.triggerCooldown(waitMs);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

async function apiGet<T = any>(path: string, params?: Record<string, any>): Promise<T> {
  return withRetry(async () => {
    await rateLimiter.waitForSlot();
    const resp = await client.get(path, { params });
    return resp.data;
  });
}

async function apiPost<T = any>(path: string, data: any): Promise<T> {
  return withRetry(async () => {
    await rateLimiter.waitForSlot();
    try {
      const resp = await client.post(path, data);
      return resp.data;
    } catch (err: any) {
      if (err.response && err.response.status === 422) {
        logger.error(MODULE, `apiPost 422 on ${path}: ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  });
}

async function apiPatch<T = any>(path: string, data: any): Promise<T> {
  return withRetry(async () => {
    await rateLimiter.waitForSlot();
    try {
      const resp = await client.patch(path, data);
      return resp.data;
    } catch (err: any) {
      if (err.response && err.response.status === 422) {
        logger.error(MODULE, `apiPatch 422 on ${path}: ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  });
}

async function apiDelete<T = any>(path: string): Promise<T> {
  return withRetry(async () => {
    await rateLimiter.waitForSlot();
    const resp = await client.delete(path);
    return resp.data;
  });
}

// --- Interfaces ---

export interface SellibriImageAttribute {
  remote_url?: string;
  base64_data?: string;
  position?: number;
  alt?: string;
}

export interface SellibriMasterAttributes {
  sku?: string;
  price?: string;
  barcode?: string;
  weight?: number;
  width?: number | null;
  height?: number | null;
  length?: number | null;
  track_inventory?: boolean;
  tax_rate_id?: number;
  stock_items_attributes?: { stock_location_id: number; available: number }[];
  images_attributes?: SellibriImageAttribute[];
}

export interface SellibriProductPayload {
  product: {
    title?: string;
    slug?: string;
    status?: string;
    description?: string;
    product_vendor_id?: number | null;
    taxon_ids?: number[];
    master_attributes?: SellibriMasterAttributes;
  };
}

export interface SellibriVariantDetail {
  id: number;
  sku: string;
  price: string;
  barcode: string | null;
  weight: string | null;
  width: string | null;
  height: string | null;
  length: string | null;
  images: { id: number; url: string }[];
  stock_items: { id: number; stock_location_id: number; available: number }[];
}

export interface SellibriProduct {
  id: number;
  title: string;
  slug: string;
  status: string;
  description: string | null;
  product_vendor_id: number | null;
  all_variants: SellibriVariantDetail[];
  taxon_ids?: number[];
}

// --- In-Memory Catalog Cache ---
let catalogCache: Map<string, SellibriProduct> | null = null;
let catalogLoadedAt: number = 0;
const CATALOG_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/** Get the in-memory catalog. Loads from API if not cached or expired. */
export async function getCatalog(forceReload = false): Promise<Map<string, SellibriProduct>> {
  const age = Date.now() - catalogLoadedAt;
  if (!catalogCache || forceReload || age > CATALOG_MAX_AGE_MS) {
    catalogCache = await fetchAllProductsFromApi();
    catalogLoadedAt = Date.now();
  }
  return catalogCache;
}

/** Invalidate the cache (e.g. after reset) */
export function invalidateCatalog(): void {
  catalogCache = null;
  catalogLoadedAt = 0;
}

/** Update the in-memory catalog entry for a SKU (after create/update) */
function updateCatalogEntry(sku: string, product: SellibriProduct): void {
  if (catalogCache) {
    catalogCache.set(sku, product);
  }
}

/** Remove a SKU from the in-memory catalog (after delete) */
function removeCatalogEntry(sku: string): void {
  if (catalogCache) {
    catalogCache.delete(sku);
  }
}

// --- Catalog Loading (internal) ---
let duplicateProducts: { sku: string; id: number }[] = [];
let noSkuProducts: number[] = [];

export function getDuplicates(): { sku: string; id: number }[] {
  return duplicateProducts;
}

export function getNoSkuProducts(): number[] {
  return noSkuProducts;
}

export function clearCleanupLists(): void {
  duplicateProducts = [];
  noSkuProducts = [];
}

async function fetchAllProductsFromApi(): Promise<Map<string, SellibriProduct>> {
  const map = new Map<string, SellibriProduct>();
  duplicateProducts = [];
  noSkuProducts = [];
  let page = 1;
  const perPage = 50;
  let consecutiveErrors = 0;

  while (true) {
    try {
      const data = await apiGet('/products', { per_page: perPage, page });
      const products: SellibriProduct[] = data.products || [];
      if (products.length === 0) break;
      consecutiveErrors = 0;

      for (const p of products) {
        let productHasSku = false;
        for (const v of p.all_variants || []) {
          if (v.sku && v.sku.trim()) {
            productHasSku = true;
            const existing = map.get(v.sku);
            if (existing && existing.id !== p.id) {
              duplicateProducts.push({ sku: v.sku, id: p.id });
            } else {
              map.set(v.sku, p);
            }
          }
        }
        if (!productHasSku) {
          noSkuProducts.push(p.id);
        }
      }

      if (page % 20 === 0 || products.length < perPage) {
        logger.info(MODULE, `Catalog page ${page} (${map.size} SKUs)`);
      }
      if (products.length < perPage) break;
    } catch (err: any) {
      const status = (err as AxiosError)?.response?.status;
      consecutiveErrors++;
      logger.warn(MODULE, `Catalog page ${page} error (HTTP ${status || '?'}): ${err.message} [${consecutiveErrors}/5]`);
      if (consecutiveErrors >= 5) {
        logger.error(MODULE, `Too many consecutive errors, stopping at page ${page}`);
        break;
      }
    }
    page++;
  }

  if (duplicateProducts.length > 0) {
    logger.warn(MODULE, `Found ${duplicateProducts.length} duplicate SKUs -- will be deleted`);
  }
  if (noSkuProducts.length > 0) {
    logger.warn(MODULE, `Found ${noSkuProducts.length} products without SKU -- will be deleted`);
  }

  logger.info(MODULE, `Sellibri catalog loaded: ${page} pages, ${map.size} SKUs, ${noSkuProducts.length} without SKU`);
  return map;
}

/** Public alias -- always uses the cache */
export async function fetchAllProducts(): Promise<Map<string, SellibriProduct>> {
  return getCatalog();
}

/** Fetch a single Sellibri product by its ID */
export async function fetchProductById(id: number): Promise<SellibriProduct | null> {
  try {
    const data = await apiGet(`/products/${id}`);
    return data.product || data || null;
  } catch (err: any) {
    if ((err as AxiosError)?.response?.status === 404) return null;
    throw err;
  }
}

// --- CRUD ---

export async function createProduct(payload: SellibriProductPayload): Promise<SellibriProduct> {
  const data = await apiPost('/products', payload);
  const product = data.product || data;
  // Update in-memory catalog
  const sku = payload.product?.master_attributes?.sku;
  if (sku && product) {
    updateCatalogEntry(sku, product);
  }
  return product;
}

export async function updateProduct(id: number, payload: SellibriProductPayload): Promise<SellibriProduct> {
  const data = await apiPatch(`/products/${id}`, payload);
  const product = data.product || data;
  // Update in-memory catalog
  const sku = payload.product?.master_attributes?.sku || product?.all_variants?.[0]?.sku;
  if (sku && product) {
    updateCatalogEntry(sku, product);
  }
  return product;
}

/** Delete a product from Sellibri by its ID */
export async function deleteProduct(id: number, sku?: string): Promise<boolean> {
  try {
    await apiDelete(`/products/${id}`);
    if (sku) removeCatalogEntry(sku);
    logger.info(MODULE, `Deleted product id=${id}`);
    return true;
  } catch (err: any) {
    const status = (err as AxiosError)?.response?.status;
    if (status === 404) {
      if (sku) removeCatalogEntry(sku);
      return true;
    }
    logger.error(MODULE, `Failed to delete product id=${id}: ${err.message}`);
    return false;
  }
}

/** Deactivate a product in Sellibri (set status='draft') */
export async function deactivateProduct(id: number): Promise<boolean> {
  try {
    await apiPatch(`/products/${id}`, {
      product: { title: '', status: 'draft' },
    });
    return true;
  } catch (err: any) {
    logger.error(MODULE, `Failed to deactivate product id=${id}: ${err.message}`);
    return false;
  }
}
