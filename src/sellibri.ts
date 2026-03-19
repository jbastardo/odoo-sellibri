import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from './config';
import { logger } from './logger';

const MODULE = 'sellibri';

// Rate limiter: 4 req/sec, 240/min
class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxPerSecond = 4;
  private readonly maxPerMinute = 240;

  async waitForSlot(): Promise<void> {
    const now = Date.now();

    // Clean old timestamps
    this.timestamps = this.timestamps.filter(t => now - t < 60_000);

    // Check per-minute limit
    if (this.timestamps.length >= this.maxPerMinute) {
      const oldest = this.timestamps[0];
      const waitMs = 60_000 - (now - oldest) + 50;
      logger.warn(MODULE, `Rate limit (per-min): waiting ${waitMs}ms`);
      await this.delay(waitMs);
      return this.waitForSlot();
    }

    // Check per-second limit
    const recentSecond = this.timestamps.filter(t => now - t < 1000);
    if (recentSecond.length >= this.maxPerSecond) {
      const oldest = recentSecond[0];
      const waitMs = 1000 - (now - oldest) + 50;
      await this.delay(waitMs);
      return this.waitForSlot();
    }

    this.timestamps.push(Date.now());
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

const rateLimiter = new RateLimiter();

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

/** Retry wrapper for 429 (Too Many Requests) with exponential backoff */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = (err as AxiosError)?.response?.status;
      if (status === 429 && attempt < maxRetries) {
        const waitSec = Math.pow(2, attempt + 1) * 15; // 30s, 60s, 120s
        logger.warn(MODULE, `Rate limited (429), waiting ${waitSec}s before retry ${attempt + 1}/${maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
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
    title: string;
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

/** Fetch ALL products from Sellibri with pagination. Builds SKU→product map.
 *  Note: Sellibri API caps per_page at 50 regardless of what you request. */
export async function fetchAllProducts(): Promise<Map<string, SellibriProduct>> {
  const map = new Map<string, SellibriProduct>();
  let page = 1;
  const perPage = 50; // API maximum is 50

  while (true) {
    const data = await apiGet('/products', { per_page: perPage, page });
    const products: SellibriProduct[] = data.products || [];
    if (products.length === 0) break;

    for (const p of products) {
      for (const v of p.all_variants || []) {
        if (v.sku) {
          map.set(v.sku, p);
        }
      }
    }

    if (page % 20 === 0 || products.length < perPage) {
      logger.info(MODULE, `Loaded Sellibri catalog page ${page} (${map.size} SKUs total)`);
    }
    if (products.length < perPage) break;
    page++;
  }

  logger.info(MODULE, `Sellibri catalog fully loaded: ${page} pages, ${map.size} SKUs`);
  return map;
}

/** Search for a product by SKU by scanning ALL pages.
 *  Sellibri API ignores query/filter parameters, so we must paginate
 *  through the entire catalog and match variant SKU locally. */
export async function findProductBySku(sku: string): Promise<SellibriProduct | null> {
  try {
    let page = 1;
    while (true) {
      const data = await apiGet('/products', { per_page: 50, page });
      const products: SellibriProduct[] = data.products || [];
      if (products.length === 0) break;

      for (const p of products) {
        for (const v of p.all_variants || []) {
          if (v.sku === sku) {
            return p;
          }
        }
      }

      if (products.length < 50) break;
      page++;
    }
    return null;
  } catch (err: any) {
    if ((err as AxiosError)?.response?.status === 404) return null;
    throw err;
  }
}

/** Fetch a single Sellibri product by its ID (full details) */
export async function fetchProductById(id: number): Promise<SellibriProduct | null> {
  try {
    const data = await apiGet(`/products/${id}`);
    return data.product || data || null;
  } catch (err: any) {
    if ((err as AxiosError)?.response?.status === 404) return null;
    throw err;
  }
}

export async function createProduct(payload: SellibriProductPayload): Promise<SellibriProduct> {
  const data = await apiPost('/products', payload);
  return data.product || data;
}

export async function updateProduct(id: number, payload: SellibriProductPayload): Promise<SellibriProduct> {
  const data = await apiPatch(`/products/${id}`, payload);
  return data.product || data;
}

export async function updateVariantStock(
  variantId: number,
  stockLocationId: number,
  available: number,
): Promise<void> {
  await apiPatch(`/variants/${variantId}`, {
    variant: {
      stock_items: [{
        stock_location_id: stockLocationId,
        available: Math.max(0, Math.floor(available)),
      }],
    },
  });
}

/** Batch execute promises with concurrency limit, respecting rate limiter */
export async function batchExecute<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number = 3,
): Promise<(T | Error)[]> {
  const results: (T | Error)[] = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      try {
        results[i] = await tasks[i]();
      } catch (err: any) {
        results[i] = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
