import { apiGet, apiPost } from './sellibri';
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
  const map = new Map<string, { taxonomyId: number; taxonId: number; name: string }>();

  try {
    const data = await apiGet('/taxonomies');
    const taxonomies = data.taxonomies || [];

    for (const tax of taxonomies) {
      try {
        const txData = await apiGet(`/taxonomies/${tax.id}/taxons`);
        const taxons = txData.taxons || [];
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
  try {
    const data = await apiPost('/taxonomies', { taxonomy: { name } });
    const taxonomy = data.taxonomy || data;
    const taxonomyId = taxonomy.id;

    // The taxonomy creation usually creates a root taxon automatically
    // Fetch the taxons to get the root taxon ID
    const txData = await apiGet(`/taxonomies/${taxonomyId}/taxons`);
    const taxons = txData.taxons || [];
    if (taxons.length > 0) {
      logger.info(MODULE, `Created taxonomy "${name}" (id=${taxonomyId}, taxon_id=${taxons[0].id})`);
      return { taxonomyId, taxonId: taxons[0].id };
    }

    // If no root taxon, create one
    const txCreate = await apiPost(`/taxonomies/${taxonomyId}/taxons`, {
      taxon: { name },
    });
    const taxon = txCreate.data?.taxon || txCreate.taxon || txCreate;
    logger.info(MODULE, `Created taxonomy "${name}" (id=${taxonomyId}, taxon_id=${taxon.id})`);
    return { taxonomyId, taxonId: taxon.id };
  } catch (err: any) {
    logger.error(MODULE, `Failed to create taxonomy "${name}": ${err.message}`);
    return null;
  }
}

/** Build the category mapping dynamically.
 *  Uses pre-mapped Sellibri taxons from STATIC_MAP.
 *  Called once at sync start, cached for the session. */
export async function buildCategoryMap(odooCategories: { id: number; name: string }[]): Promise<void> {
  categoryMap = new Map();
  for (const [k, v] of Object.entries(STATIC_MAP)) {
    categoryMap.set(Number(k), v);
  }
  defaultTaxonId = 8318;
  logger.info(MODULE, `Category map initialized with ${categoryMap.size} mappings (default=${defaultTaxonId})`);
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
