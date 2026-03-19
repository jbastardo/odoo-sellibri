import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from './config';
import { logger } from './logger';

const MODULE = 'sellibri';

// ─── Adaptive Rate Limiter ─────────────────────────────────────
// Conservative: 2 req/sec steady, global cooldown on 429

class AdaptiveRateLimiter {
  private lastRequestTime = 0;
  private minInterval = 600; // 600ms between requests = ~1.6 req/sec (safe under 4/sec limit)
  private cooldownUntil = 0; // Global cooldown timestamp — all requests wait

  async waitForSlot(): Promise<void> {
    // Wait for global cooldown (set when ANY request gets a 429)
    const now = Date.now();
    if (this.cooldownUntil > now) {
      const waitMs = this.cooldownUntil - now;
      logger.warn(MODULE, `Global cooldown active, waiting ${Math.round(waitMs / 1000)}s`);
      await this.delay(waitMs);
    }

    // Ensure minimum interval between requests
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      await this.delay(this.minInterval - elapsed);
    }

    this.lastRequestTime = Date.now();
  }

  /** Called when we get a 429 — blocks ALL subsequent requests for the given duration */
  triggerCooldown(durationMs: number): void {
    const newCooldown = Date.now() + durationMs;
    // Only extend cooldown, never shorten it
    if (newCooldown > this.cooldownUntil) {
      this.cooldownUntil = newCooldown;
      logger.warn(MODULE, `429 received — global cooldown for ${Math.round(durationMs / 1000)}s`);
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
  timeout: 60_000,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

/** Retry wrapper with adaptive backoff on 429 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 4): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = (err as AxiosError)?.response?.status;
      if (status === 429 && attempt < maxRetries) {
        // Exponential: 45s, 90s, 180s, 360s
        const waitMs = Math.pow(2, attempt) * 45_000;
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
    const resp = await client.post(path, data);
    return resp.data;
  });
}

async function apiPatch<T = any>(path: string, data: any): Promise<T> {
  return withRetry(async () => {
    await rateLimiter.waitForSlot();
    const resp = await client.patch(path, data);
    return resp.data;
  });
}

async function apiDelete<T = any>(path: string): Promise<T> {
  return withRetry(async () => {
    await rateLimiter.waitForSlot();
    const resp = await client.delete(path);
    return resp.data;
  });
}

// ─── Interfaces ────────────────────────────────────────────────

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
  status: string;
  description: string | null;
  product_vendor_id: number | null;
  all_variants: SellibriVariantDetail[];
  taxon_ids?: number[];
}

// ─── Catalog Loading ───────────────────────────────────────────

/** Fetch ALL products from Sellibri with pagination. Builds SKU→product map.
 *  Resilient: skips individual page errors, stops after 5 consecutive failures. */
export async function fetchAllProducts(): Promise<Map<string, SellibriProduct>> {
  const map = new Map<string, SellibriProduct>();
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
        for (const v of p.all_variants || []) {
          if (v.sku) {
            map.set(v.sku, p);
          }
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

  logger.info(MODULE, `Sellibri catalog loaded: ${page} pages, ${map.size} SKUs`);
  return map;
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

// ─── CRUD ──────────────────────────────────────────────────────

export async function createProduct(payload: SellibriProductPayload): Promise<SellibriProduct> {
  const data = await apiPost('/products', payload);
  return data.product || data;
}

export async function updateProduct(id: number, payload: SellibriProductPayload): Promise<SellibriProduct> {
  const data = await apiPatch(`/products/${id}`, payload);
  return data.product || data;
}

/** Delete a product from Sellibri by its ID */
export async function deleteProduct(id: number): Promise<boolean> {
  try {
    await apiDelete(`/products/${id}`);
    logger.info(MODULE, `Deleted product id=${id}`);
    return true;
  } catch (err: any) {
    const status = (err as AxiosError)?.response?.status;
    if (status === 404) {
      return true; // Already gone
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

// ─── Sequential Batch Executor ─────────────────────────────────
// Concurrency = 1 to avoid overloading Sellibri API

export async function batchExecute<T>(
  tasks: (() => Promise<T>)[],
  _concurrency: number = 1, // Ignored — always sequential to prevent 429 storms
): Promise<(T | Error)[]> {
  const results: (T | Error)[] = new Array(tasks.length);

  for (let i = 0; i < tasks.length; i++) {
    try {
      results[i] = await tasks[i]();
    } catch (err: any) {
      results[i] = err instanceof Error ? err : new Error(String(err));
    }
  }

  return results;
}
