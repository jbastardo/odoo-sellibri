import express from 'express';
import * as cron from 'node-cron';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';
import { syncProducts, syncPriceStock, syncSingleSku, syncPhotos, syncCleanup, getSyncStatus, requestAbort, resetSyncState } from './sync';
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
  res.json({ message: 'Price/Stock sync started' });
  syncPriceStock().catch(err => {
    logger.error('api', `Manual price/stock sync error: ${err.message}`);
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

// Cleanup: delete from Sellibri products not in Odoo
app.post('/api/sync/cleanup', async (_req, res) => {
  const status = getSyncStatus();
  if (status.isRunning) {
    res.json({ message: 'Sync already running' });
    return;
  }
  res.json({ message: 'Cleanup started — comparing Odoo vs Sellibri...' });
  syncCleanup().then(result => {
    logger.info('api', `Cleanup finished: ${result.deleted} deleted, ${result.failed} failed, ${result.orphanSkus.length} orphans found`);
  }).catch(err => {
    logger.error('api', `Cleanup error: ${err.message}`);
  });
});

// Abort sync
app.post('/api/sync/abort', (_req, res) => {
  const aborted = requestAbort();
  res.json({
    success: aborted,
    message: aborted ? 'Sincronización detenida' : 'No hay sincronización en curso',
  });
});

// Reset sync state (clear all mappings, force full re-sync)
app.post('/api/sync/reset', (_req, res) => {
  const status = getSyncStatus();
  if (status.isRunning) {
    res.json({ success: false, message: 'No se puede resetear mientras hay una sincronización en curso' });
    return;
  }
  resetSyncState();
  res.json({ success: true, message: 'Estado de sincronización eliminado. La próxima sync empezará desde cero.' });
});

// Webhook endpoint
app.post('/webhook/orders', handleOrderWebhook);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// === Cron Jobs ===

// Product sync every 30 minutes (smart sync: fills empty fields, always updates price/qty)
cron.schedule('*/30 * * * *', () => {
  const status = getSyncStatus();
  if (status.isRunning) {
    logger.warn('cron', 'Skipping scheduled product sync — another sync is running');
    return;
  }
  logger.info('cron', 'Triggering scheduled product sync');
  syncProducts().catch(err => {
    logger.error('cron', `Scheduled product sync error: ${err.message}`);
  });
});

// Price/Stock sync every 15 minutes
cron.schedule('*/15 * * * *', () => {
  const status = getSyncStatus();
  if (status.isRunning) {
    logger.warn('cron', 'Skipping scheduled price/stock sync — another sync is running');
    return;
  }
  logger.info('cron', 'Triggering scheduled price/stock sync');
  syncPriceStock().catch(err => {
    logger.error('cron', `Scheduled price/stock sync error: ${err.message}`);
  });
});

// Cleanup: delete orphans from Sellibri every 6 hours
cron.schedule('0 */6 * * *', () => {
  const status = getSyncStatus();
  if (status.isRunning) {
    logger.warn('cron', 'Skipping scheduled cleanup — another sync is running');
    return;
  }
  logger.info('cron', 'Triggering scheduled cleanup (delete Sellibri orphans)');
  syncCleanup().then(result => {
    if (result.deleted > 0) {
      logger.info('cron', `Cleanup: deleted ${result.deleted} orphan products from Sellibri`);
    }
  }).catch(err => {
    logger.error('cron', `Scheduled cleanup error: ${err.message}`);
  });
});

logger.info('server', 'Cron auto-sync ENABLED: products/30min, price-stock/15min, cleanup/6h');

// === Start Server ===

app.listen(config.port, () => {
  logger.info('server', `Odoo-Sellibri integration running on port ${config.port}`);
  logger.info('server', `Dashboard: http://localhost:${config.port}`);
  logger.info('server', `Webhook endpoint: http://localhost:${config.port}/webhook/orders`);
});
