import express from 'express';
import * as cron from 'node-cron';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';
import { syncProducts, syncStock, syncSingleSku, syncPhotos, getSyncStatus } from './sync';
import { handleOrderWebhook, getRecentOrders } from './webhook';

const app = express();

// Raw body capture for HMAC verification on webhook route
app.use('/webhook', express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf.toString();
  },
}));

// JSON parser for other routes
app.use(express.json());

// Serve dashboard
app.use(express.static(path.join(__dirname, '..', 'public')));

// === API Routes ===

// Dashboard data endpoint
app.get('/api/status', (_req, res) => {
  res.json({
    sync: getSyncStatus(),
    recentOrders: getRecentOrders(),
    logs: logger.getLogs(100),
  });
});

// Manual sync triggers
app.post('/api/sync/products', async (_req, res) => {
  const status = getSyncStatus();
  if (status.isRunning) {
    res.json({ message: 'Sync already running' });
    return;
  }
  res.json({ message: 'Product sync started' });
  syncProducts().catch(err => {
    logger.error('api', `Manual product sync error: ${err.message}`);
  });
});

app.post('/api/sync/stock', async (_req, res) => {
  const status = getSyncStatus();
  if (status.isRunning) {
    res.json({ message: 'Sync already running' });
    return;
  }
  res.json({ message: 'Stock sync started' });
  syncStock().catch(err => {
    logger.error('api', `Manual stock sync error: ${err.message}`);
  });
});

// Force sync a single SKU (all fields + images)
app.post('/api/sync/sku/:sku', async (req, res) => {
  const { sku } = req.params;
  if (!sku || sku.trim() === '') {
    res.status(400).json({ success: false, message: 'SKU requerido' });
    return;
  }
  logger.info('api', `Manual force sync for SKU=${sku}`);
  const result = await syncSingleSku(sku.trim());
  res.json(result);
});

// Sync photos for products without images
app.post('/api/sync/photos', async (_req, res) => {
  const status = getSyncStatus();
  if (status.isRunning) {
    res.json({ message: 'Sync already running' });
    return;
  }
  res.json({ message: 'Photo sync started' });
  syncPhotos().catch(err => {
    logger.error('api', `Photo sync error: ${err.message}`);
  });
});

// Webhook endpoint
app.post('/webhook/orders', handleOrderWebhook);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// === Cron Jobs ===

// Product sync every 30 minutes
cron.schedule('*/30 * * * *', () => {
  logger.info('cron', 'Triggering scheduled product sync');
  syncProducts().catch(err => {
    logger.error('cron', `Scheduled product sync error: ${err.message}`);
  });
});

// Stock sync every 15 minutes
cron.schedule('*/15 * * * *', () => {
  logger.info('cron', 'Triggering scheduled stock sync');
  syncStock().catch(err => {
    logger.error('cron', `Scheduled stock sync error: ${err.message}`);
  });
});

// === Start Server ===

app.listen(config.port, () => {
  logger.info('server', `Odoo-Sellibri integration running on port ${config.port}`);
  logger.info('server', `Dashboard: http://localhost:${config.port}`);
  logger.info('server', `Webhook endpoint: http://localhost:${config.port}/webhook/orders`);
});
