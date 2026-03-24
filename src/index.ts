import express from 'express';
import * as cron from 'node-cron';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';
import { syncMirror, syncPriceStock, syncSingleSku, getSyncStatus, requestAbort, resetSyncState } from './sync';
import { fetchExcludedProducts, diagnoseSku } from './odoo';
import { handleOrderWebhook, getRecentOrders } from './webhook';

const app = express();

// ─── Manual action lock ────────────────────────────────────────
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

app.use(express.json());

// Serve dashboard
app.use(express.static(path.join(__dirname, '..', 'public')));

// === API Routes ===

app.get('/api/status', (_req, res) => {
  res.json({
    sync: getSyncStatus(),
    recentOrders: getRecentOrders(),
    logs: logger.getLogs(100),
  });
});

// ── Sync Espejo: full mirror (create + update + delete) ──
app.post('/api/sync/mirror', async (_req, res) => {
  if (!startManualAction('Sync Espejo')) {
    res.json({ message: 'Ya hay una sincronización en curso' });
    return;
  }
  res.json({ message: 'Sync espejo iniciada — comparando Odoo vs Sellibri...' });
  syncMirror()
    .then(r => logger.info('api', `Espejo: ${r.created} creados, ${r.updated} corregidos, ${r.unchanged} sin cambios, ${r.deleted} eliminados, ${r.skippedInvalid} inválidos, ${r.errors} errores`))
    .catch(err => logger.error('api', `Sync espejo error: ${err.message}`))
    .finally(() => endManualAction('Sync Espejo'));
});

// ── Precio/Stock manual ──
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

// ── Actualizar SKU (single product full overwrite) ──
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

// ── Abort ──
app.post('/api/sync/abort', (_req, res) => {
  const aborted = requestAbort();
  if (aborted) {
    manualActionRunning = false;
  }
  res.json({
    success: aborted,
    message: aborted ? 'Sincronización detenida' : 'No hay sincronización en curso',
  });
});

// ── Reset state ──
app.post('/api/sync/reset', (_req, res) => {
  const status = getSyncStatus();
  if (status.isRunning || manualActionRunning) {
    res.json({ success: false, message: 'No se puede resetear mientras hay una sincronización en curso' });
    return;
  }
  resetSyncState();
  res.json({ success: true, message: 'Estado de sincronización eliminado. La próxima sync empezará desde cero.' });
});

// ── Diagnostic ──
app.get('/api/diagnostic/excluded', async (_req, res) => {
  try {
    const result = await fetchExcludedProducts();
    res.json({
      success: true,
      total_odoo: result.total,
      syncable: result.syncable,
      excluded_count: result.excluded.length,
      excluded: result.excluded,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Diagnose SKU (all fields) ──
app.get('/api/diag/:sku', async (req, res) => {
  const { sku } = req.params;
  try {
    const result = await diagnoseSku(sku.trim());
    if (!result) {
      res.status(404).json({ success: false, message: `SKU ${sku} not found in Odoo` });
      return;
    }
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Webhook endpoint
app.post('/webhook/orders', handleOrderWebhook);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// === Cron Jobs ===

// Cron 1: Precio/Stock cada 15 min
cron.schedule('*/15 * * * *', () => {
  if (manualActionRunning) {
    logger.info('cron', 'Cron precio/stock omitido — acción manual en curso');
    return;
  }
  const status = getSyncStatus();
  if (status.isRunning) {
    logger.info('cron', 'Cron precio/stock omitido — sync en curso');
    return;
  }
  logger.info('cron', 'Cron: sincronizando precio/stock');
  syncPriceStock().catch(err => {
    logger.error('cron', `Cron precio/stock error: ${err.message}`);
  });
});

// Cron 2: Sync Espejo DESACTIVADO — solo manual desde dashboard
// cron.schedule('0 * * * *', () => {
//   if (manualActionRunning) {
//     logger.info('cron', 'Cron espejo omitido — acción manual en curso');
//     return;
//   }
//   const status = getSyncStatus();
//   if (status.isRunning) {
//     logger.info('cron', 'Cron espejo omitido — sync en curso');
//     return;
//   }
//   logger.info('cron', 'Cron: sync espejo (crear/actualizar/eliminar)');
//   syncMirror().catch(err => {
//     logger.error('cron', `Cron espejo error: ${err.message}`);
//   });
// });

logger.info('server', 'Cron activo: precio/stock cada 15 min | espejo: solo manual');

// === Start Server ===

app.listen(config.port, () => {
  logger.info('server', `Odoo-Sellibri integration running on port ${config.port}`);
  logger.info('server', `Dashboard: http://localhost:${config.port}`);
});
