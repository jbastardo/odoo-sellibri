import 'dotenv/config';

export const config = {
  odoo: {
    url: process.env.ODOO_URL || 'https://www.onprotec.shop',
    db: process.env.ODOO_DB || 'binaural-dev-onprotec-16-release-8815487',
    username: process.env.ODOO_USERNAME || '',
    apiKey: process.env.ODOO_API_KEY || '',
  },
  sellibri: {
    baseUrl: process.env.SELLIBRI_BASE_URL || 'https://onprotec.com/api/v1',
    apiKey: process.env.SELLIBRI_API_KEY || '',
    stockLocationId: parseInt(process.env.SELLIBRI_STOCK_LOCATION_ID || '1206', 10),
    taxRateId: parseInt(process.env.SELLIBRI_TAX_RATE_ID || '4049', 10),
    webhookSecret: process.env.SELLIBRI_WEBHOOK_SECRET || '',
  },
  ivaRate: parseFloat(process.env.IVA_RATE || '0.16'),
  port: parseInt(process.env.PORT || '3000', 10),
  cronEnabled: process.env.CRON_ENABLED !== 'false',
  deleteProtectionSkus: (process.env.DELETE_PROTECTION_SKUS || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0),
};
