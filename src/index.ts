import express from 'express';
import * as cron from 'node-cron';
import * as path from 'path';
import axios from 'axios';
import { config } from './config';
import { logger } from './logger';
import { syncMirror, syncPriceStock, syncSingleSku, getSyncStatus, requestAbort, resetSyncState } from './sync';
import { fetchProducts, fetchExcludedProducts, diagnoseSku, findProductName, searchProductByName, getTemplateAllFields, fetchTemplateName, fetchNameFromWebsite, getProductWebsiteUrl } from './odoo';
import { handleOrderWebhook, getRecentOrders } from './webhook';

const app = express();

// --- Manual action lock ----------------------------------------
let manualActionRunning = false;
let apiEnabled = true;

function startManualAction(name: string): boolean {
  const status = getSyncStatus();
  if (status.isRunning || manualActionRunning) {
    return false;
  }
  manualActionRunning = true;
  logger.info('api', `Manual action started: ${name} -- cron blocked until finished`);
  return true;
}

function endManualAction(name: string): void {
  manualActionRunning = false;
  logger.info('api', `Manual action finished: ${name} -- cron unblocked`);
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
    apiEnabled,
  });
});

// --- Toggle API on/off ---
app.post('/api/toggle', (_req, res) => {
  apiEnabled = !apiEnabled;
  logger.info('api', `API ${apiEnabled ? 'encendida' : 'apagada'} manualmente`);
  res.json({ success: true, apiEnabled, message: apiEnabled ? 'API encendida' : 'API apagada' });
});

// --- Sync Espejo: full mirror (create + update + delete) ---
app.post('/api/sync/mirror', async (_req, res) => {
  if (!startManualAction('Sync Espejo')) {
    res.json({ message: 'Ya hay una sincronizacion en curso' });
    return;
  }
  res.json({ message: 'Sync espejo iniciada -- comparando Odoo vs Sellibri...' });
  syncMirror()
    .then(r => logger.info('api', `Espejo: ${r.created} creados, ${r.updated} corregidos, ${r.unchanged} sin cambios, ${r.deleted} eliminados, ${r.skippedInvalid} invalidos, ${r.errors} errores`))
    .catch(err => logger.error('api', `Sync espejo error: ${err.message}`))
    .finally(() => endManualAction('Sync Espejo'));
});

// --- Precio/Stock manual ---
app.post('/api/sync/stock', async (_req, res) => {
  if (!startManualAction('Precio/Stock')) {
    res.json({ message: 'Ya hay una sincronizacion en curso' });
    return;
  }
  res.json({ message: 'Sincronizacion precio/stock iniciada' });
  syncPriceStock()
    .catch(err => logger.error('api', `Manual price/stock sync error: ${err.message}`))
    .finally(() => endManualAction('Precio/Stock'));
});

// --- Actualizar SKU (single product full overwrite) ---
app.post('/api/sync/sku/:sku', async (req, res) => {
  const { sku } = req.params;
  if (!sku || sku.trim() === '') {
    res.status(400).json({ success: false, message: 'SKU requerido' });
    return;
  }
  if (!startManualAction(`SKU ${sku.trim()}`)) {
    res.json({ success: false, message: 'Ya hay una sincronizacion en curso' });
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

// --- Abort ---
app.post('/api/sync/abort', (_req, res) => {
  const aborted = requestAbort();
  if (aborted) {
    manualActionRunning = false;
  }
  res.json({
    success: aborted,
    message: aborted ? 'Sincronizacion detenida' : 'No hay sincronizacion en curso',
  });
});

// --- Reset state ---
app.post('/api/sync/reset', (_req, res) => {
  const status = getSyncStatus();
  if (status.isRunning || manualActionRunning) {
    res.json({ success: false, message: 'No se puede resetear mientras hay una sincronizacion en curso' });
    return;
  }
  resetSyncState();
  res.json({ success: true, message: 'Estado de sincronizacion eliminado. La proxima sync empezara desde cero.' });
});

// --- Diagnostic ---
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

// --- Diagnose SKU (all fields) ---
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

// --- Find actual name field for SKU ---
app.get('/api/name/:sku', async (req, res) => {
  const { sku } = req.params;
  try {
    const result = await findProductName(sku.trim());
    res.json({ success: true, sku, fields: result });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- Search products by name ---
app.get('/api/search/:term', async (req, res) => {
  const { term } = req.params;
  try {
    const result = await searchProductByName(term.trim());
    res.json({ success: true, term, products: result });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- Get ALL template fields ---
app.get('/api/template-fields/:sku', async (req, res) => {
  const { sku } = req.params;
  try {
    const result = await getTemplateAllFields(sku.trim());
    res.json({ success: true, sku, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- Diagnostic: find products with name/code mismatch ---
app.get('/api/diag-name-mismatch/:limit?', async (req, res) => {
  const limit = parseInt(req.params.limit || '200') || 200;
  try {
    const allProducts = await fetchProducts();
    const mismatches: any[] = [];
    
    for (const p of allProducts.slice(0, limit)) {
      const sku = p.default_code;
      const name = p.name || '';
      if (!sku || !name) continue;
      
      const match = name.match(/\[([0-9]+)\]/);
      if (match && match[1] !== sku) {
        const websiteUrl = await getProductWebsiteUrl(sku);
        mismatches.push({
          sku,
          nameSku: match[1],
          name: name.substring(0, 100),
          websiteUrl: websiteUrl?.substring(0, 80),
        });
      }
    }
    
    res.json({ total: allProducts.length, checked: limit, mismatches: mismatches.slice(0, 50) });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- Diagnostic: find products with wrong template association ---
app.get('/api/diag-wrong-template/:limit?', async (req, res) => {
  const limit = parseInt(req.params.limit || '500') || 500;
  try {
    const allProducts = await fetchProducts();
    const wrongTemplates: any[] = [];
    
    for (const p of allProducts.slice(0, limit)) {
      const sku = p.default_code;
      const name = p.name || '';
      if (!sku || !name) continue;
      
      const kitMatch = name.match(/\[(KIT[A-Z0-9]+)-/);
      if (!kitMatch) continue;
      const kitCode = kitMatch[1];
      
      const websiteUrl = await getProductWebsiteUrl(sku);
      if (!websiteUrl) continue;
      
      const templateMatch = websiteUrl.match(/-(\d+)(?:#|$)/);
      if (!templateMatch) continue;
      const templateId = parseInt(templateMatch[1]);
      
      const urlKitMatch = websiteUrl.match(/\/shop\/(kit[A-Z0-9]+)-/i);
      if (urlKitMatch && urlKitMatch[1].toUpperCase() !== kitCode.toUpperCase()) {
        wrongTemplates.push({
          sku,
          kitInName: kitCode,
          urlKit: urlKitMatch[1],
          templateId,
          name: name.substring(0, 80),
          websiteUrl: websiteUrl.substring(0, 80),
        });
      }
    }
    
    res.json({ total: allProducts.length, checked: limit, wrongTemplates });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- Fetch name from website using product's website URL ---
app.get('/api/web-name/:sku', async (req, res) => {
  const { sku } = req.params;
  try {
    const debug: any = {};
    
    const websiteUrl = await getProductWebsiteUrl(sku);
    debug.storedUrl = websiteUrl;
    let fullUrl = websiteUrl?.startsWith('http') ? websiteUrl : websiteUrl ? `${config.odoo.url}${websiteUrl}` : null;
    
    if (!fullUrl) {
      debug.search = 'trying shop search';
      const searchResp = await axios.get(`${config.odoo.url}/shop?search=${sku}`, {
        timeout: 15000,
        maxRedirects: 10,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const searchHtml = searchResp.data;
      const linkMatch = searchHtml.match(new RegExp(`<a[^>]*href=["'](/shop/[^"']*-${sku}[^"']*)[^>]*>`, 'i'));
      if (linkMatch) {
        fullUrl = `${config.odoo.url}${linkMatch[1]}`;
        debug.foundBySearch = true;
      }
    }
    
    if (fullUrl) {
      const productResp = await axios.get(fullUrl, {
        timeout: 15000,
        maxRedirects: 10,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      
      const productHtml = productResp.data;
      const ogTitleMatch = productHtml.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
      const metaTitleMatch = productHtml.match(/<meta[^>]*name=["']default_title["'][^>]*content=["']([^"']+)["']/i);
      const titleMatch = productHtml.match(/<title>([^|<]+)/i);
      const name = ogTitleMatch?.[1] || metaTitleMatch?.[1] || titleMatch?.[1];
      const cleanName = name?.replace(/\s*\|\s*onprotec\s*$/i, '').trim();
      
      res.json({ success: true, sku, websiteName: cleanName, productUrl: fullUrl, debug });
      return;
    }
    
    res.json({ success: true, sku, websiteName: null, debug });
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
  logger.info('cron', 'Iniciando sync precio/stock...');
  if (!config.cronEnabled) {
    logger.info('cron', 'Cron precio/stock omitido -- Cron deshabilitado en config');
    return;
  }
  if (!apiEnabled) {
    logger.info('cron', 'Cron precio/stock omitido -- API apagada');
    return;
  }
  if (manualActionRunning) {
    logger.info('cron', 'Cron precio/stock omitido -- accion manual en curso');
    return;
  }
  const status = getSyncStatus();
  if (status.isRunning) {
    logger.info('cron', 'Cron precio/stock omitido -- sync en curso');
    return;
  }
  logger.info('cron', 'Cron: sincronizando precio/stock');
  syncPriceStock().catch(err => {
    logger.error('cron', `Cron precio/stock error: ${err.message}`);
  });
}, {
  timezone: 'America/Caracas'
});

// Cron 2: Sync Espejo a las 11:00 AM Venezuela lun-vie
cron.schedule('0 11 * * 1-5', () => {
  logger.info('cron', 'Iniciando sync espejo 11am...');
  if (!config.cronEnabled) {
    logger.info('cron', 'Cron espejo 11am omitido -- Cron deshabilitado en config');
    return;
  }
  if (!apiEnabled) {
    logger.info('cron', 'Cron espejo 11am omitido -- API apagada');
    return;
  }
  if (manualActionRunning) {
    logger.info('cron', 'Cron espejo 11am omitido -- accion manual en curso');
    return;
  }
  const status = getSyncStatus();
  if (status.isRunning) {
    logger.info('cron', 'Cron espejo 11am omitido -- sync en curso');
    return;
  }
  logger.info('cron', 'Cron: sync espejo 11am (crear/actualizar/eliminar)');
  syncMirror().catch(err => {
    logger.error('cron', `Cron espejo 11am error: ${err.message}`);
  });
}, {
  timezone: 'America/Caracas'
});

// Cron 3: Sync Espejo a las 3:00 PM Venezuela lun-vie
cron.schedule('0 15 * * 1-5', () => {
  logger.info('cron', 'Iniciando sync espejo 3pm...');
  if (!config.cronEnabled) {
    logger.info('cron', 'Cron espejo 3pm omitido -- Cron deshabilitado en config');
    return;
  }
  if (!apiEnabled) {
    logger.info('cron', 'Cron espejo 3pm omitido -- API apagada');
    return;
  }
  if (manualActionRunning) {
    logger.info('cron', 'Cron espejo 3pm omitido -- accion manual en curso');
    return;
  }
  const status = getSyncStatus();
  if (status.isRunning) {
    logger.info('cron', 'Cron espejo 3pm omitido -- sync en curso');
    return;
  }
  logger.info('cron', 'Cron: sync espejo 3pm (crear/actualizar/eliminar)');
  syncMirror().catch(err => {
    logger.error('cron', `Cron espejo 3pm error: ${err.message}`);
  });
}, {
  timezone: 'America/Caracas'
});

// OLD: Sync Espejo DESACTIVADO -- solo manual desde dashboard
// cron.schedule('0 * * * *', () => {
//   if (!apiEnabled) {
//     logger.info('cron', 'Cron espejo omitido -- API apagada');
//     return;
//   }
//   if (manualActionRunning) {
//     logger.info('cron', 'Cron espejo omitido -- accion manual en curso');
//     return;
//   }
//   const status = getSyncStatus();
//   if (status.isRunning) {
//     logger.info('cron', 'Cron espejo omitido -- sync en curso');
//     return;
//   }
//   logger.info('cron', 'Cron: sync espejo (crear/actualizar/eliminar)');
//   syncMirror().catch(err => {
//     logger.error('cron', `Cron espejo error: ${err.message}`);
//   });
// });

logger.info('server', 'Cron activo: precio/stock cada 15 min | espejo: 11am y 3pm lun-vie (Venezuela)');

// === Start Server ===
app.listen(config.port, () => {
  logger.info('server', `Odoo-Sellibri integration running on port ${config.port}`);
  logger.info('server', `Dashboard: http://localhost:${config.port}`);
});
