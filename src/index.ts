import express from 'express';
import * as cron from 'node-cron';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';
import { syncProducts, syncPriceStock, syncSingleSku, syncPhotos, syncCleanup, getSyncStatus, requestAbort, resetSyncState } from './sync';
import { handleOrderWebhook, getRecentOrders } from './webhook';

const app = express();

// ─── Manual action lock ────────────────────────────────────────
// When a manual action is running, cron jobs must NOT execute.
// Cleared automatically when the manual action finishes.

let manualActionRunning = false;

function startManualAction(name: string): boolean {
  const status = getSyncStatus();
  if (status.isRunning || manualActionRunning) {
    return false;
  }
  manualActionRunning = true;
  logger.info('api', `Manual action started: ${name} — cron blocked until finished`);
  return true;
}

function endManualAction(name: string): void {
  manualActionRunning = false;
  logger.info('api', `Manual action finished: ${name} — cron unblocked`);
}

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

// Manual sync triggers — all set manualActionRunning to block cron

app.post('/api/sync/products', async (_req, res) => {
  if (!startManualAction('Sincronizar Productos')) {
    res.json({ message: 'Ya hay una sincronización en curso' });
    return;
  }
  res.json({ message: 'Sincronización de productos iniciada' });
  syncProducts()
    .catch(err => logger.error('api', `Manual product sync error: ${err.message}`))
    .finally(() => endManualAction('Sincronizar Productos'));
});

app.post('/api/sync/stock', async (_req, res) => {
  if (!startManualAction('Precio/Stock')) {
    res.json({ message: 'Ya hay una sincronización en curso' });
    return;
  }
  res.json({ message: 'Sincronización precio/stock iniciada' });
  syncPriceStock()
    .catch(err => logger.error('api', `Manual price/stock sync error: ${err.message}`))
    .finally(() => endManualAction('Precio/Stock'));
});

app.post('/api/sync/sku/:sku', async (req, res) => {
  const { sku } = req.params;
  if (!sku || sku.trim() === '') {
    res.status(400).json({ success: false, message: 'SKU requerido' });
    return;
  }
  if (!startManualAction(`SKU ${sku.trim()}`)) {
    res.json({ success: false, message: 'Ya hay una sincronización en curso' });
    return;
  }
  try {
    const result = await syncSingleSku(sku.trim());
    res.json(result);
  } catch (err: any) {
    res.json({ success: false, message: err.message });
  } finally {
    endManualAction(`SKU ${sku.trim()}`);
  }
});

app.post('/api/sync/cleanup', async (_req, res) => {
  if (!startManualAction('Limpieza')) {
    res.json({ message: 'Ya hay una sincronización en curso' });
    return;
  }
  res.json({ message: 'Limpieza iniciada — comparando Odoo vs Sellibri...' });
  syncCleanup()
    .then(result => logger.info('api', `Limpieza: ${result.deleted} eliminados, ${result.failed} fallidos, ${result.orphanSkus.length} huérfanos`))
    .catch(err => logger.error('api', `Cleanup error: ${err.message}`))
    .finally(() => endManualAction('Limpieza'));
});

// Abort sync
app.post('/api/sync/abort', (_req, res) => {
  const aborted = requestAbort();
  if (aborted) {
    // Also clear manual lock so cron can resume after abort
    manualActionRunning = false;
  }
  res.json({
    success: aborted,
    message: aborted ? 'Sincronización detenida' : 'No hay sincronización en curso',
  });
});

// Reset sync state
app.post('/api/sync/reset', (_req, res) => {
  const status = getSyncStatus();
  if (status.isRunning || manualActionRunning) {
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

// === Cron: solo precio/stock cada 15 min ===

cron.schedule('*/15 * * * *', () => {
  // Block if any manual action is running
  if (manualActionRunning) {
    logger.info('cron', 'Cron omitido — acción manual en curso');
    return;
  }
  const status = getSyncStatus();
  if (status.isRunning) {
    logger.info('cron', 'Cron omitido — sync en curso');
    return;
  }
  logger.info('cron', 'Cron: sincronizando precio/stock');
  syncPriceStock().catch(err => {
    logger.error('cron', `Cron precio/stock error: ${err.message}`);
  });
});

logger.info('server', 'Cron activo: precio/stock cada 15 min');

// === Start Server ===

app.listen(config.port, () => {
  logger.info('server', `Odoo-Sellibri integration running on port ${config.port}`);
  logger.info('server', `Dashboard: http://localhost:${config.port}`);
});
