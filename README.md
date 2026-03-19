# Odoo ↔ Sellibri Integration

Bidirectional integration between Odoo 16 Enterprise and Sellibri ecommerce platform for ONPROTEC.

## Features

- **Product Sync** (Odoo → Sellibri): Cron every 30 min. Syncs products with prices (+ 16% IVA), images, categories, and stock levels.
- **Stock Sync** (Odoo → Sellibri): Cron every 15 min. Lightweight stock-only updates.
- **Order Webhook** (Sellibri → Odoo): Receives `order_create` webhooks, creates customers and sale orders in Odoo.
- **Dashboard**: Real-time monitoring of sync status, recent orders, and logs.

## Setup

```bash
cp .env.example .env
# Edit .env with your credentials
npm install
npm run build
npm start
```

## Development

```bash
npm run dev
```

## Deployment (Railway)

Push to the connected GitHub repo. Railway will auto-deploy using `railway.toml`.

## Environment Variables

See `.env.example` for all required variables.

## Architecture

```
src/
├── index.ts          # Express server, routes, cron setup
├── odoo.ts           # Odoo XML-RPC client
├── sellibri.ts       # Sellibri REST client (rate-limited)
├── sync.ts           # Sync engine (products, stock)
├── webhook.ts        # Webhook handler (orders → Odoo)
├── config.ts         # Environment config
├── logger.ts         # Logger with in-memory buffer for dashboard
└── category-map.ts   # Odoo → Sellibri category mapping
```

## Endpoints

- `GET /` — Dashboard UI
- `GET /api/status` — Sync status, recent orders, logs (JSON)
- `POST /api/sync/products` — Trigger manual product sync
- `POST /api/sync/stock` — Trigger manual stock sync
- `POST /webhook/orders` — Sellibri order webhook receiver
- `GET /health` — Health check
