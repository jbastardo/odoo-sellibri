import axios from 'axios';
import { config } from './config';
import { logger } from './logger';

const MODULE = 'category-map';

// ─── Dynamic Category Mapping ──────────────────────────────────
// Compares Odoo categories with Sellibri taxonomies/taxons.
// Matches by name (case-insensitive, trimmed).
// Creates missing categories in Sellibri automatically.
// Caches the mapping in memory after first load.

interface CategoryMapping {
  odooId: number;
  odooName: string;
  sellibriTaxonId: number;
  sellibriName: string;
}

let categoryMap: Map<number, number> | null = null; // odooCategId → sellibriTaxonId
let defaultTaxonId: number = 0;

/** Normalize a category name for matching */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[áà]/g, 'a')
    .replace(/[éè]/g, 'e')
    .replace(/[íì]/g, 'i')
    .replace(/[óò]/g, 'o')
    .replace(/[úù]/g, 'u');
}

/** Load all Sellibri taxonomies and their root taxons */
async function loadSellibriTaxons(): Promise<Map<string, { taxonomyId: number; taxonId: number; name: string }>> {
  const client = axios.create({
    baseURL: config.sellibri.baseUrl,
    headers: { 'X-Api-Key': config.sellibri.apiKey, 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  const map = new Map<string, { taxonomyId: number; taxonId: number; name: string }>();

  try {
    const resp = await client.get('/taxonomies');
    const taxonomies = resp.data.taxonomies || [];

    for (const tax of taxonomies) {
      try {
        const txResp = await client.get(`/taxonomies/${tax.id}/taxons`);
        const taxons = txResp.data.taxons || [];
        for (const t of taxons) {
          const key = normalizeName(t.name);
          map.set(key, { taxonomyId: tax.id, taxonId: t.id, name: t.name });
        }
      } catch {}
    }
  } catch (err: any) {
    logger.error(MODULE, `Failed to load Sellibri taxonomies: ${err.message}`);
  }

  return map;
}

/** Create a new taxonomy + taxon in Sellibri */
async function createSellibriTaxonomy(name: string): Promise<{ taxonomyId: number; taxonId: number } | null> {
  const client = axios.create({
    baseURL: config.sellibri.baseUrl,
    headers: { 'X-Api-Key': config.sellibri.apiKey, 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  try {
    const resp = await client.post('/taxonomies', { taxonomy: { name } });
    const taxonomy = resp.data.taxonomy || resp.data;
    const taxonomyId = taxonomy.id;

    // The taxonomy creation usually creates a root taxon automatically
    // Fetch the taxons to get the root taxon ID
    const txResp = await client.get(`/taxonomies/${taxonomyId}/taxons`);
    const taxons = txResp.data.taxons || [];
    if (taxons.length > 0) {
      logger.info(MODULE, `Created taxonomy "${name}" (id=${taxonomyId}, taxon_id=${taxons[0].id})`);
      return { taxonomyId, taxonId: taxons[0].id };
    }

    // If no root taxon, create one
    const txCreate = await client.post(`/taxonomies/${taxonomyId}/taxons`, {
      taxon: { name },
    });
    const taxon = txCreate.data.taxon || txCreate.data;
    logger.info(MODULE, `Created taxonomy "${name}" (id=${taxonomyId}, taxon_id=${taxon.id})`);
    return { taxonomyId, taxonId: taxon.id };
  } catch (err: any) {
    logger.error(MODULE, `Failed to create taxonomy "${name}": ${err.message}`);
    return null;
  }
}

/** Build the category mapping dynamically.
 *  Matches Odoo categories to Sellibri taxons by name.
 *  Creates missing taxons in Sellibri.
 *  Called once at sync start, cached for the session. */
export async function buildCategoryMap(odooCategories: { id: number; name: string }[]): Promise<void> {
  logger.info(MODULE, `Building category map: ${odooCategories.length} Odoo categories`);

  const sellibriTaxons = await loadSellibriTaxons();
  logger.info(MODULE, `Sellibri has ${sellibriTaxons.size} taxons`);

  categoryMap = new Map();

  // Find or set the default taxon (OTROS)
  const otrosKey = normalizeName('OTROS');
  const otros = sellibriTaxons.get(otrosKey);
  defaultTaxonId = otros?.taxonId || 0;

  for (const cat of odooCategories) {
    const key = normalizeName(cat.name);

    // Try exact match
    let match = sellibriTaxons.get(key);

    // Try common variations
    if (!match) {
      // "Alarma" → "Alarmas"
      match = sellibriTaxons.get(key + 's');
    }
    if (!match) {
      // "Alarmas" → "Alarma"
      match = sellibriTaxons.get(key.replace(/s$/, ''));
    }
    if (!match) {
      // "Control Acceso" → "Control de Acceso"
      for (const [sellibriKey, val] of sellibriTaxons) {
        if (sellibriKey.includes(key) || key.includes(sellibriKey)) {
          match = val;
          break;
        }
      }
    }

    if (match) {
      categoryMap.set(cat.id, match.taxonId);
      logger.info(MODULE, `  Mapped "${cat.name}" (${cat.id}) → "${match.name}" (${match.taxonId})`);
    } else {
      // Create the category in Sellibri
      logger.info(MODULE, `  Category "${cat.name}" not found in Sellibri — creating...`);
      const created = await createSellibriTaxonomy(cat.name);
      if (created) {
        categoryMap.set(cat.id, created.taxonId);
        sellibriTaxons.set(key, { taxonomyId: created.taxonomyId, taxonId: created.taxonId, name: cat.name });
      } else {
        // Fallback to OTROS
        categoryMap.set(cat.id, defaultTaxonId);
        logger.warn(MODULE, `  "${cat.name}" → fallback to OTROS (${defaultTaxonId})`);
      }
    }
  }

  logger.info(MODULE, `Category map built: ${categoryMap.size} mappings, default=${defaultTaxonId}`);
}

/** Get the Sellibri taxon ID for an Odoo category.
 *  Must call buildCategoryMap() first (done at sync start). */
export function mapCategory(odooCategId: number): number {
  if (!categoryMap) {
    // Fallback to static map if not initialized yet
    return STATIC_MAP[odooCategId] ?? 8318;
  }
  return categoryMap.get(odooCategId) ?? defaultTaxonId;
}

/** Invalidate the cached map (e.g., after manual changes) */
export function invalidateCategoryMap(): void {
  categoryMap = null;
}

// Static fallback (used if buildCategoryMap hasn't been called yet)
const STATIC_MAP: Record<number, number> = {
  1353: 8328, // Alarma → Alarmas
  1354: 8344, // CCTV → CCTV
  1355: 8329, // Computación → Computación
  1356: 8330, // Control Acceso → Control de Acceso
  1358: 8331, // Electrónicos → Electrónicos
  1360: 8332, // Ferretería → Ferretería
  1361: 8333, // Iluminación → Iluminación
  1362: 8334, // Oficina y Hogar → Oficina y Hogar
  1363: 8335, // Redes → Redes
  1364: 8336, // Seguridad → Seguridad
};
