import * as crypto from 'crypto';
import { Request, Response } from 'express';
import { config } from './config';
import * as odoo from './odoo';
import { logger } from './logger';

const MODULE = 'webhook';

export interface WebhookOrder {
  id: number;
  number: string;
  state: string;
  total: string;
  item_total: string;
  tax_total: string;
  line_items: {
    variant_id: number;
    sku: string;
    quantity: number;
    price: string;
  }[];
  user: {
    email: string;
    first_name: string;
    last_name: string;
  };
  shipping_address?: {
    address1?: string;
    city?: string;
    zipcode?: string;
    phone?: string;
    country_id?: number;
  };
  billing_address?: {
    address1?: string;
    city?: string;
    zipcode?: string;
    phone?: string;
  };
}

interface OrderCreatedEvent {
  orders: WebhookOrder[];
}

let recentOrders: { timestamp: string; orderNumber: string; status: string; error?: string }[] = [];

export function getRecentOrders() {
  return recentOrders.slice(-50);
}

function verifyHmac(body: string, signature: string): boolean {
  if (!config.sellibri.webhookSecret) {
    logger.warn(MODULE, 'No webhook secret configured, skipping HMAC validation');
    return true;
  }
  const computed = crypto
    .createHmac('sha256', config.sellibri.webhookSecret)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(computed, 'hex'),
    Buffer.from(signature, 'hex'),
  );
}

export async function handleOrderWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers['x-webhook-signature'] as string || '';
  const rawBody = (req as any).rawBody as string;

  if (!rawBody) {
    logger.error(MODULE, 'No raw body available for HMAC verification');
    res.status(400).json({ error: 'Missing body' });
    return;
  }

  // Verify HMAC
  if (config.sellibri.webhookSecret && signature) {
    try {
      if (!verifyHmac(rawBody, signature)) {
        logger.error(MODULE, 'Invalid HMAC signature');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    } catch (err: any) {
      logger.error(MODULE, `HMAC verification error: ${err.message}`);
      res.status(401).json({ error: 'Signature verification failed' });
      return;
    }
  }

  let event: OrderCreatedEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    logger.error(MODULE, 'Invalid JSON body');
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  // Respond immediately
  res.status(200).json({ received: true });

  // Process orders asynchronously
  const orders = event.orders || [];
  for (const order of orders) {
    await processOrder(order);
  }
}

async function processOrder(order: WebhookOrder): Promise<void> {
  const orderNum = order.number || `#${order.id}`;
  logger.info(MODULE, `Processing order ${orderNum}`);

  try {
    // Find or create customer
    const email = order.user.email;
    let partnerId = await odoo.findPartnerByEmail(email);

    if (!partnerId) {
      const partnerData: any = {
        name: `${order.user.first_name} ${order.user.last_name}`.trim(),
        email,
      };
      if (order.shipping_address) {
        if (order.shipping_address.phone) partnerData.phone = order.shipping_address.phone;
        if (order.shipping_address.address1) partnerData.street = order.shipping_address.address1;
        if (order.shipping_address.city) partnerData.city = order.shipping_address.city;
        if (order.shipping_address.zipcode) partnerData.zip = order.shipping_address.zipcode;
      }
      partnerId = await odoo.createPartner(partnerData);
    }

    // Build order lines
    const lines: { product_id: number; product_uom_qty: number; price_unit: number }[] = [];
    for (const item of order.line_items) {
      const productId = await odoo.findProductBySku(item.sku);
      if (!productId) {
        logger.warn(MODULE, `SKU ${item.sku} not found in Odoo for order ${orderNum}`);
        continue;
      }
      // Price from Sellibri includes IVA, convert back to Odoo price (without IVA)
      const priceWithIva = parseFloat(item.price);
      const priceUnit = priceWithIva / (1 + config.ivaRate);
      lines.push({
        product_id: productId,
        product_uom_qty: item.quantity,
        price_unit: parseFloat(priceUnit.toFixed(2)),
      });
    }

    if (lines.length === 0) {
      logger.warn(MODULE, `No valid lines for order ${orderNum}, skipping`);
      recentOrders.push({
        timestamp: new Date().toISOString(),
        orderNumber: orderNum,
        status: 'skipped',
        error: 'No matching products',
      });
      return;
    }

    // Create sale order
    const orderId = await odoo.createSaleOrder(partnerId, lines);
    logger.info(MODULE, `Order ${orderNum} → sale.order #${orderId}`);

    recentOrders.push({
      timestamp: new Date().toISOString(),
      orderNumber: orderNum,
      status: 'created',
    });

    // Keep only last 50
    if (recentOrders.length > 50) {
      recentOrders = recentOrders.slice(-50);
    }
  } catch (err: any) {
    logger.error(MODULE, `Failed to process order ${orderNum}: ${err.message}`);
    recentOrders.push({
      timestamp: new Date().toISOString(),
      orderNumber: orderNum,
      status: 'error',
      error: err.message,
    });
  }
}
