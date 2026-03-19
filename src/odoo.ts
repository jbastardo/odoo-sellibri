import * as xmlrpc from 'xmlrpc';
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
  const uid = await call(client, 'authenticate', [
    config.odoo.db,
    config.odoo.username,
    config.odoo.apiKey,
    {},
  ]);
  if (!uid) throw new Error('Odoo authentication failed');
  cachedUid = uid as number;
  logger.info(MODULE, `Authenticated with UID: ${uid}`);
  return uid;
}

async function execute(model: string, method: string, args: any[], kwargs: Record<string, any> = {}): Promise<any> {
  const uid = await authenticate();
  const client = createClient('/xmlrpc/2/object');
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
  qty_available: number;
  weight: number;
  barcode: string | false;
  categ_id: [number, string] | false;
  brand_id: [number, string] | false;
  description_sale: string | false;
  website_description: string | false;
  image_1920: string | false;
  product_template_image_ids: number[];
  write_date: string;
  sale_ok: boolean;
  type: string;
}

export async function fetchProducts(
  offset = 0,
  limit = 100,
  lastWriteDate?: string,
): Promise<OdooProduct[]> {
  const domain: any[] = [
    ['sale_ok', '=', true],
    ['type', '=', 'product'],
    ['default_code', '!=', false],
    ['default_code', '!=', ''],
  ];
  if (lastWriteDate) {
    domain.push(['write_date', '>', lastWriteDate]);
  }

  const products = await execute('product.product', 'search_read', [domain], {
    fields: [
      'name', 'default_code', 'list_price', 'qty_available', 'weight',
      'barcode', 'categ_id', 'brand_id', 'description_sale',
      'website_description', 'image_1920', 'product_template_image_ids',
      'write_date', 'sale_ok', 'type',
    ],
    offset,
    limit,
    order: 'write_date asc',
  });

  return products as OdooProduct[];
}

export async function fetchAllProducts(lastWriteDate?: string): Promise<OdooProduct[]> {
  const all: OdooProduct[] = [];
  let offset = 0;
  const batchSize = 200;

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

export interface ProductImage {
  id: number;
  name: string;
  image_1920: string | false;
}

export async function fetchProductImages(imageIds: number[]): Promise<ProductImage[]> {
  if (imageIds.length === 0) return [];
  const images = await execute('product.image', 'read', [imageIds], {
    fields: ['name', 'image_1920'],
  });
  return images as ProductImage[];
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
