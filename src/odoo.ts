import * as xmlrpc from 'xmlrpc';
import axios from 'axios';
import { config } from './config';
import { logger } from './logger';

const MODULE = 'odoo';

function createClient(path: string): xmlrpc.Client {
  const url = new URL(path, config.odoo.url);
  if (url.protocol === 'https:') {
    return xmlrpc.createSecureClient({
      host: url.hostname,
      port: 443,
      path: url.pathname,
    });
  }
  return xmlrpc.createClient({
    host: url.hostname,
    port: 80,
    path: url.pathname,
  });
}

function call(client: xmlrpc.Client, method: string, params: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err: any, value: any) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
}

let cachedUid: number | null = null;

async function authenticate(): Promise<number> {
  if (cachedUid) return cachedUid;
  const client = createClient('/xmlrpc/2/common');
  
  const authParams = {
    db: config.odoo.db,
    username: config.odoo.username,
    apiKey: config.odoo.apiKey?.substring(0, 10) + '...',
  };
  logger.info(MODULE, `Authenticating to Odoo: ${JSON.stringify(authParams)}`);
  
  const uid = await call(client, 'authenticate', [
    config.odoo.db,
    config.odoo.username,
    config.odoo.apiKey,
    {},
  ]);
  
  logger.info(MODULE, `Auth raw response: ${JSON.stringify(uid)}`);
  if (!uid || uid === false) throw new Error('Odoo authentication failed');
  cachedUid = uid as number;
  logger.info(MODULE, `Authenticated with UID: ${uid}`);
  return uid;
}

async function execute(model: string, method: string, args: any[], kwargs: Record<string, any> = {}): Promise<any> {
  const uid = await authenticate();
  const client = createClient('/xmlrpc/2/object');
  
  // Force language to Spanish to avoid getting base English translations
  const lang = process.env.ODOO_LANG || 'es_VE';
  if (!kwargs.context) {
    kwargs.context = { lang };
  } else {
    kwargs.context.lang = kwargs.context.lang || lang;
  }
  
  return call(client, 'execute_kw', [
    config.odoo.db,
    uid,
    config.odoo.apiKey,
    model,
    method,
    args,
    kwargs,
  ]);
}

export interface OdooProduct {
  id: number;
  name: string;
  default_code: string;
  list_price: number;
  price_with_tax: number;
  qty_available: number;
  virtual_available: number;
  free_qty: number;
  weight: number;
  barcode: string | false;
  categ_id: [number, string] | false;
  brand_id: [number, string] | false;
  description_sale: string | false;
  website_description: string | false;
  image_1920: string | boolean;
  product_tmpl_id: [number, string] | false;
  product_template_image_ids: number[];
  product_variant_image_ids?: number[];
  write_date: string;
  sale_ok: boolean;
  type: string;
  is_kits: boolean;
}

export interface OdooProductImageUrls {
  mainUrl: string | null;
  additionalUrls: { id: number; url: string; position: number }[];
}

export async function fetchProducts(
  offset = 0,
  limit = 100,
  lastWriteDate?: string,
): Promise<OdooProduct[]> {
  const domain: any[] = [
    ['active', '=', true],
    ['sale_ok', '=', true],
    ['type', 'in', ['product', 'consu']],
    ['default_code', '!=', false],
    ['default_code', '!=', ''],
  ];
  if (lastWriteDate) {
    domain.push(['write_date', '>', lastWriteDate]);
  }

  // NOTE: Do NOT include image_1920 here — it causes OOM with thousands of products.
  const products = await execute('product.product', 'search_read', [domain], {
    fields: [
      'name', 'default_code', 'list_price', 'price_with_tax', 'qty_available', 'virtual_available', 'free_qty', 'weight',
      'barcode', 'categ_id', 'brand_id', 'description_sale',
      'website_description', 'product_tmpl_id', 'product_template_image_ids', 'product_variant_image_ids',
      'write_date', 'sale_ok', 'type', 'image_128'
    ],
    offset,
    limit,
    order: 'write_date asc, id asc',
  });

  return products as OdooProduct[];
}

export async function fetchAllProducts(lastWriteDate?: string): Promise<OdooProduct[]> {
  const all: OdooProduct[] = [];
  let offset = 0;
  const batchSize = 500;

  while (true) {
    logger.info(MODULE, `Fetching products offset=${offset} limit=${batchSize}`);
    const batch = await fetchProducts(offset, batchSize, lastWriteDate);
    all.push(...batch);
    if (batch.length < batchSize) break;
    offset += batchSize;
  }

  logger.info(MODULE, `Fetched ${all.length} products total`);
  return all;
}

/** Lightweight fetch: SKU + qty_available + virtual_available + free_qty + price_with_tax for price/stock sync */
export interface StockPriceProduct {
  id: number;
  default_code: string;
  qty_available: number;
  virtual_available: number;
  free_qty: number;
  price_with_tax: number;
}

export async function fetchStockAndPrices(): Promise<StockPriceProduct[]> {
  const all: StockPriceProduct[] = [];
  let offset = 0;
  const batchSize = 1000;

  while (true) {
    const batch = await execute('product.product', 'search_read', [
      [['active', '=', true], ['sale_ok', '=', true], ['type', 'in', ['product', 'consu']], ['default_code', '!=', false], ['default_code', '!=', '']],
    ], {
      fields: ['default_code', 'qty_available', 'virtual_available', 'free_qty', 'price_with_tax'],
      offset,
      limit: batchSize,
    });
    all.push(...(batch as StockPriceProduct[]));
    if (batch.length < batchSize) break;
    offset += batchSize;
  }

  return all;
}

export interface ProductImage {
  id: number;
  name: string;
  image_1920: string | false;
}

/** Fetch the main image (image_1920) for a single product by ID.
 *  Returns the base64 string or null if no image exists.
 *  This avoids loading all images in bulk which causes OOM. */
export async function fetchProductMainImage(productId: number): Promise<string | null> {
  try {
    const result = await execute('product.product', 'read', [[productId]], {
      fields: ['image_1920'],
    });
    if (result && result.length > 0 && result[0].image_1920 && typeof result[0].image_1920 === 'string') {
      return result[0].image_1920;
    }
    return null;
  } catch (err: any) {
    logger.warn(MODULE, `Failed to fetch image for product ${productId}: ${err.message}`);
    return null;
  }
}

export async function fetchProductImages(imageIds: number[]): Promise<ProductImage[]> {
  if (imageIds.length === 0) return [];
  const images = await execute('product.image', 'read', [imageIds], {
    fields: ['name', 'image_1920'],
  });
  return images as ProductImage[];
}

/** Build public image URLs for an Odoo product.
 *  - Main image: /web/image/product.product/{id}/image_1920
 *  - Additional images: /web/image/product.image/{image_id}/image_1920
 *  Uses product_template_image_ids for extra images (model: product.image). */
export function buildImageUrls(product: OdooProduct): OdooProductImageUrls {
  const baseUrl = config.odoo.url.replace(/\/$/, '');
  const result: OdooProductImageUrls = {
    mainUrl: null,
    additionalUrls: [],
  };

  // Main image — uses the product.template ID which is PUBLIC
  // If product_tmpl_id is an array (e.g. [123, 'Name']), we take the first element
  const tmplId = Array.isArray(product.product_tmpl_id) 
    ? product.product_tmpl_id[0] 
    : product.product_tmpl_id;

  const safeSku = encodeURIComponent(product.default_code.replace(/[^a-zA-Z0-9_-]/g, '_'));

  // We fetch image_128 without bin_size because Odoo 16 computes placeholder size dynamically,
  // making bin_size return truthy even for placeholders. image_128 returns false if missing.
  const hasMainImage = !!product.image_128;

  if (hasMainImage) {
    // We always point to product.product so we get the correct variant image if it was overridden,
    // otherwise Odoo gracefully falls back to the template image anyway.
    result.mainUrl = `${baseUrl}/web/image/product.product/${product.id}/image_1920/${safeSku}_main.jpg`;
  }

  // Additional images from product.image model
  const extraImageIds = new Set<number>();
  if (product.product_template_image_ids && product.product_template_image_ids.length > 0) {
    product.product_template_image_ids.forEach(id => extraImageIds.add(id));
  }
  if (product.product_variant_image_ids && product.product_variant_image_ids.length > 0) {
    product.product_variant_image_ids.forEach(id => extraImageIds.add(id));
  }

  const extraImagesArray = Array.from(extraImageIds);
  for (let i = 0; i < extraImagesArray.length; i++) {
    const imageId = extraImagesArray[i];
    result.additionalUrls.push({
      id: imageId,
      url: `${baseUrl}/web/image/product.image/${imageId}/image_1920/${safeSku}_ext_${i}.jpg`,
      position: i + 2, // position 1 = main image, 2+ = additional
    });
  }

  return result;
}

/** Fetch additional image IDs from product.template if product.product doesn't have them.
 *  Some Odoo configs only store extra images on the template level. */
export async function fetchTemplateImageIds(templateId: number): Promise<number[]> {
  try {
    const tmpl = await execute('product.template', 'read', [[templateId]], {
      fields: ['product_template_image_ids'],
    });
    if (tmpl && tmpl[0]?.product_template_image_ids) {
      return tmpl[0].product_template_image_ids;
    }
  } catch (err: any) {
    logger.warn(MODULE, `Failed to fetch template images for template ${templateId}: ${err.message}`);
  }
  return [];
}

/** Check if a product has a real main image (not a placeholder) by checking image_128 field */
export async function productHasImage(productId: number): Promise<boolean> {
  try {
    const result = await execute('product.product', 'read', [[productId]], {
      fields: ['image_128'],
    });
    return !!(result && result[0] && result[0].image_128);
  } catch {
    return false;
  }
}

export async function fetchStockQuants(productIds: number[]): Promise<Record<number, number>> {
  if (productIds.length === 0) return {};

  const quants = await execute('stock.quant', 'search_read', [
    [
      ['product_id', 'in', productIds],
      ['location_id.usage', '=', 'internal'],
    ],
  ], {
    fields: ['product_id', 'quantity', 'reserved_quantity'],
  });

  const stockMap: Record<number, number> = {};
  for (const q of quants as any[]) {
    const pid = q.product_id[0];
    const available = (q.quantity || 0) - (q.reserved_quantity || 0);
    stockMap[pid] = (stockMap[pid] || 0) + available;
  }
  return stockMap;
}

export async function findPartnerByEmail(email: string): Promise<number | null> {
  const ids = await execute('res.partner', 'search', [
    [['email', '=', email]],
  ], { limit: 1 });
  return ids.length > 0 ? ids[0] : null;
}

export async function createPartner(data: {
  name: string;
  email: string;
  phone?: string;
  street?: string;
  city?: string;
  zip?: string;
  country_id?: number;
}): Promise<number> {
  const id = await execute('res.partner', 'create', [data]);
  logger.info(MODULE, `Created partner id=${id} email=${data.email}`);
  return id;
}

export async function findProductBySku(sku: string): Promise<number | null> {
  const ids = await execute('product.product', 'search', [
    [['default_code', '=', sku]],
  ], { limit: 1 });
  return ids.length > 0 ? ids[0] : null;
}

/** Fetch a single product by SKU with all sync-relevant fields */
export async function fetchProductBySku(sku: string): Promise<OdooProduct | null> {
  const products = await execute('product.product', 'search_read', [
    [['default_code', '=', sku], ['active', '=', true], ['sale_ok', '=', true], ['type', 'in', ['product', 'consu']]],
  ], {
    fields: [
      'name', 'default_code', 'list_price', 'price_with_tax', 'qty_available', 'virtual_available', 'free_qty', 'weight',
      'barcode', 'categ_id', 'brand_id', 'description_sale',
      'website_description', 'product_tmpl_id', 'product_template_image_ids', 'product_variant_image_ids',
      'write_date', 'sale_ok', 'type', 'image_128'
    ],
    limit: 1,
  });
  if (products && products.length > 0) return products[0] as OdooProduct;
  return null;
}

/** Lightweight fetch: get all active (sellable, storable, with SKU) product SKUs from Odoo.
 *  Used by cleanup logic to determine which products should exist in Sellibri. */
export async function fetchAllActiveSKUs(): Promise<Set<string>> {
  const skus = new Set<string>();
  let offset = 0;
  const batchSize = 2000;

  while (true) {
    const batch = await execute('product.product', 'search_read', [
      [['active', '=', true], ['sale_ok', '=', true], ['type', 'in', ['product', 'consu']], ['default_code', '!=', false], ['default_code', '!=', '']],
    ], {
      fields: ['default_code'],
      offset,
      limit: batchSize,
    });
    for (const p of batch as { default_code: string }[]) {
      if (p.default_code) skus.add(p.default_code);
    }
    if (batch.length < batchSize) break;
    offset += batchSize;
  }

  logger.info(MODULE, `Fetched ${skus.size} active SKUs from Odoo`);
  return skus;
}

/** Diagnostic: fetch ALL products (no type filter) and classify why some are excluded from sync */
export interface ExcludedProduct {
  id: number;
  name: string;
  default_code: string | false;
  type: string;
  sale_ok: boolean;
  list_price: number;
  price_with_tax: number;
  reason: string;
}

export async function fetchExcludedProducts(): Promise<{ total: number; syncable: number; excluded: ExcludedProduct[] }> {
  const all: any[] = [];
  let offset = 0;
  const batchSize = 500;

  // Fetch ALL products without type/sale_ok filters — only basic existence filters
  while (true) {
    const batch = await execute('product.product', 'search_read', [
      [['active', '=', true]],
    ], {
      fields: ['name', 'default_code', 'type', 'sale_ok', 'list_price', 'price_with_tax'],
      offset,
      limit: batchSize,
    });
    all.push(...batch);
    if (batch.length < batchSize) break;
    offset += batchSize;
  }

  const excluded: ExcludedProduct[] = [];
  let syncable = 0;

  for (const p of all) {
    const reasons: string[] = [];

    if (!p.sale_ok) reasons.push('sale_ok=false');
    if (p.type !== 'product' && p.type !== 'consu') reasons.push(`type=${p.type} (no es product ni consu)`);
    if (!p.default_code || (typeof p.default_code === 'string' && p.default_code.trim() === '')) reasons.push('sin SKU');

    // Validate price
    const price = p.price_with_tax > 0 ? p.price_with_tax : p.list_price * (1 + 0.16);
    if (!price || price <= 0) reasons.push('precio=0');
    if (!p.name || p.name.trim() === '') reasons.push('sin nombre');

    if (reasons.length > 0) {
      excluded.push({
        id: p.id,
        name: p.name || '(sin nombre)',
        default_code: p.default_code || false,
        type: p.type,
        sale_ok: p.sale_ok,
        list_price: p.list_price,
        price_with_tax: p.price_with_tax,
        reason: reasons.join(', '),
      });
    } else {
      syncable++;
    }
  }

  return { total: all.length, syncable, excluded };
}

/** Fetch all product categories used by active products */
export async function fetchActiveCategories(): Promise<{ id: number; name: string }[]> {
  const cats = await execute('product.category', 'search_read', [
    [['id', '!=', 0]],
  ], { fields: ['name'], limit: 200 });

  // Only return categories that have at least one active product
  const products = await execute('product.product', 'search_read', [
    [['active', '=', true], ['sale_ok', '=', true], ['type', 'in', ['product', 'consu']], ['default_code', '!=', false]],
  ], { fields: ['categ_id'], limit: 10000 });

  const usedIds = new Set<number>();
  for (const p of products) {
    const cid = Array.isArray(p.categ_id) ? p.categ_id[0] : 0;
    if (cid) usedIds.add(cid);
  }

  return (cats as { id: number; name: string }[]).filter(c => usedIds.has(c.id));
}// Web scraping functions removed because they are too slow and trigger WAF

let templateNameCache = new Map<number, string | null>();
let templateDescCache = new Map<number, string | null>();
let templateHasImageCache = new Map<number, boolean>();

export function clearTemplateCache(): void {
  templateNameCache.clear();
  templateDescCache.clear();
  templateHasImageCache.clear();
  logger.info(MODULE, 'Template cache cleared');
}

/** Get product name from Odoo directly via API to avoid WAF blocks and latency. */
export async function fetchTemplateName(productTmplId: number, fallbackSku?: string): Promise<string | null> {
  if (templateNameCache.has(productTmplId)) {
    return templateNameCache.get(productTmplId) || null;
  }
  
  try {
    const result = await execute('product.template', 'read', [[productTmplId]], {
      fields: ['name', 'website_meta_title', 'display_name', 'image_1920'],
      context: { bin_size: true }
    });
    
    if (result && result.length > 0) {
      const tmpl = result[0];
      // Prioritize tmpl.name. website_meta_title is often outdated when a product is duplicated.
      const apiName = tmpl.name || tmpl.display_name || tmpl.website_meta_title;
      logger.info(MODULE, `Template fields: name="${tmpl.name}", display_name="${tmpl.display_name}", website_meta_title="${tmpl.website_meta_title}"`);
      
      // Save whether the template actually has a main image
      templateHasImageCache.set(productTmplId, !!tmpl.image_1920);
      
      if (apiName) {
        // Basic normalization in case it contains simple HTML entities
        const normalized = apiName
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#34;/g, '"')
          .trim();
          
        templateNameCache.set(productTmplId, normalized);
        return normalized;
      }
    }
    
    templateNameCache.set(productTmplId, null);
    return null;
  } catch (err: any) {
    logger.warn(MODULE, `Failed to fetch template name for tmpl_id=${productTmplId}: ${err.message}`);
    templateNameCache.set(productTmplId, null);
    return null;
  }
}

/** Fetch description from product.template for duplicated products.
 * Tries multiple description fields. */
export async function fetchTemplateDescription(productTmplId: number): Promise<string | null> {
  if (templateDescCache.has(productTmplId)) {
    return templateDescCache.get(productTmplId) || null;
  }
  
  try {
    const result = await execute('product.template', 'read', [[productTmplId]], {
      fields: ['website_description', 'description', 'description_sale'],
    });
    if (result && result.length > 0) {
      const tmpl = result[0];
      const desc = tmpl.website_description || tmpl.description || tmpl.description_sale || null;
      templateDescCache.set(productTmplId, desc);
      return desc;
    }
    templateDescCache.set(productTmplId, null);
    return null;
  } catch (err: any) {
    logger.warn(MODULE, `Failed to fetch template description for tmpl_id=${productTmplId}: ${err.message}`);
    templateDescCache.set(productTmplId, null);
    return null;
  }
}

export async function createSaleOrder(partnerId: number, lines: { product_id: number; product_uom_qty: number; price_unit: number }[]): Promise<number> {
  const orderLines = lines.map(l => [0, 0, {
    product_id: l.product_id,
    product_uom_qty: l.product_uom_qty,
    price_unit: l.price_unit,
  }]);

  const orderId = await execute('sale.order', 'create', [{
    partner_id: partnerId,
    order_line: orderLines,
  }]);

  logger.info(MODULE, `Created sale.order id=${orderId} for partner=${partnerId}`);

  // Confirm the sale order
  try {
    await execute('sale.order', 'action_confirm', [[orderId]]);
    logger.info(MODULE, `Confirmed sale.order id=${orderId}`);
  } catch (err: any) {
    logger.warn(MODULE, `Could not confirm sale.order id=${orderId}: ${err.message}`);
  }

  return orderId;
}


                                /** Diagnostic: fetch ALL fields for a product by SKU + its template */
export async function diagnoseSku(sku: string): Promise<{ product: any; template: any } | null> {
  const products = await execute('product.product', 'search_read', [
    [['default_code', '=', sku]],
  ], { limit: 1 });
  if (!products || products.length === 0) return null;
  const product = products[0];
  let template: any = null;
  if (product.product_tmpl_id && Array.isArray(product.product_tmpl_id)) {
    const tmplId = product.product_tmpl_id[0];
    const tmplResult = await execute('product.template', 'read', [[tmplId]], {});
    if (tmplResult && tmplResult.length > 0) template = tmplResult[0];
  }
  // Remove heavy binary fields to avoid huge responses
  if (product.image_1920) product.image_1920 = '(binary omitted)';
  if (product.image_1024) product.image_1024 = '(binary omitted)';
  if (product.image_512) product.image_512 = '(binary omitted)';
  if (product.image_256) product.image_256 = '(binary omitted)';
  if (product.image_128) product.image_128 = '(binary omitted)';
  if (template) {
    if (template.image_1920) template.image_1920 = '(binary omitted)';
    if (template.image_1024) template.image_1024 = '(binary omitted)';
    if (template.image_512) template.image_512 = '(binary omitted)';
    if (template.image_256) template.image_256 = '(binary omitted)';
    if (template.image_128) template.image_128 = '(binary omitted)';
  }
  return { product, template };
}

/** Search products by name in Odoo to find variants */
export async function searchProductByName(searchTerm: string): Promise<{ id: number; name: string; default_code: string }[]> {
  const products = await execute('product.product', 'search_read', [
    [['name', 'ilike', searchTerm], ['sale_ok', '=', true]],
  ], { fields: ['name', 'default_code'], limit: 20 });
  return products;
}

/** Get product website URL by SKU */
export async function getProductWebsiteUrl(sku: string): Promise<string | null> {
  const products = await execute('product.product', 'search_read', [
    [['default_code', '=', sku]],
  ], { fields: ['website_url'], limit: 1 });
  if (products && products.length > 0 && products[0].website_url) {
    return products[0].website_url;
  }
  return null;
}

/** Get ALL fields from product.template to find name fields */
export async function getTemplateAllFields(sku: string): Promise<any> {
  const products = await execute('product.product', 'search_read', [
    [['default_code', '=', sku]],
  ], { limit: 1 });
  
  if (!products || products.length === 0) return null;
  const product = products[0];
  
  if (product.product_tmpl_id && Array.isArray(product.product_tmpl_id)) {
    const tmplId = product.product_tmpl_id[0];
    const templateData = await execute('product.template', 'read', [[tmplId]], {
      fields: ['name', 'seo_name', 'url_slug', 'website_meta_title', 'display_name'],
    });
    return { product, template: templateData };
  }
  
  return { product };
}

/** Fetch name from website by searching page for the SKU */
export async function fetchNameFromWebsite(sku: string): Promise<string | null> {
  try {
    // Try the base URL and search for the SKU
    const url = `${config.odoo.url}/shop?search=${sku}`;
    const response = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 10,
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' 
      },
    });
    
    const html = response.data;
    
    // Look for the product link containing this SKU
    const productLinkMatch = html.match(new RegExp(`<a[^>]*href=["']/(shop/[0-9]+-${sku}[^"']*)[^>]*>`, 'i'));
    
    if (productLinkMatch) {
      const productUrl = `${config.odoo.url}${productLinkMatch[1]}`;
      const productResp = await axios.get(productUrl, {
        timeout: 15000,
        maxRedirects: 10,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      
      const productHtml = productResp.data;
      
      // Get the title
      const metaTitleMatch = productHtml.match(/<meta[^>]*name=["']default_title["'][^>]*content=["']([^"']+)["']/i);
      if (metaTitleMatch) {
        const name = metaTitleMatch[1].replace(/\s*\|\s*onprotec\s*$/i, '').trim();
        logger.info(MODULE, `fetchNameFromWebsite(${sku}): meta default_title="${name}"`);
        return name;
      }
      
      const ogTitleMatch = productHtml.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
      if (ogTitleMatch) {
        return ogTitleMatch[1].trim();
      }
      
      const titleMatch = productHtml.match(/<title>([^|<]+)/i);
      if (titleMatch) {
        return titleMatch[1].replace(/\s*\|\s*onprotec\s*$/i, '').trim();
      }
    }
    
    return null;
  } catch (err: any) {
    logger.warn(MODULE, `fetchNameFromWebsite error: ${err.message}`);
    return null;
  }
}

/** Debug: find the actual product name field by checking all possible name-related fields */
export async function findProductName(sku: string): Promise<{ source: string; value: string }[]> {
  const results: { source: string; value: string }[] = [];
  
  const products = await execute('product.product', 'search_read', [
    [['default_code', '=', sku]],
  ], { limit: 1 });
  
  if (!products || products.length === 0) return results;
  const product = products[0];
  
  // Check product.product fields
  results.push({ source: 'product_product.name', value: product.name || '' });
  results.push({ source: 'product_product.default_code', value: product.default_code || '' });
  
  if (product.product_tmpl_id && Array.isArray(product.product_tmpl_id)) {
    const tmplId = product.product_tmpl_id[0];
    
    // Get all fields from template (only valid fields)
    const tmplResult = await execute('product.template', 'read', [[tmplId]], {
      fields: ['name', 'display_name', 'default_code'],
    });
    
    if (tmplResult && tmplResult.length > 0) {
      const t = tmplResult[0];
      results.push({ source: 'product_template.name', value: t.name || '' });
      results.push({ source: 'product_template.display_name', value: t.display_name || '' });
      results.push({ source: 'product_template.default_code', value: t.default_code || '' });
    }
  }
  
  return results;
}
export { execute };
