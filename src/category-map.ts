// Odoo categ_id → Sellibri taxon_id mapping
// Sellibri taxons (tutecnotienda.com):
//   10920: REDES, 10921: COMPUTACION, 10916: ENERGIA,
//   10917: TABLETS, 10919: ELECTRODOMESTISCOS, 10924: PORTATILES,
//   10925: CELULARES, 10926: SERVIDORES, 10941: Impresoras,
//   10922: ESCANNERS, 10923: CONSUMIBLES

const CATEGORY_MAP: Record<number, number> = {
  1353: 10920, // Alarma → REDES (no hay categoría Alarma en Sellibri)
  1354: 10920, // CCTV → REDES (no hay categoría CCTV en Sellibri)
  1355: 10921, // Computación → COMPUTACION
  1356: 10920, // Control Acceso → REDES (no hay equivalente)
  1358: 10919, // Electrónicos → ELECTRODOMESTISCOS
  1360: 10920, // Ferretería → REDES (no hay equivalente)
  1361: 10920, // Iluminación → REDES (no hay equivalente)
  1362: 10921, // Oficina y Hogar → COMPUTACION
  1363: 10920, // Redes → REDES
  1364: 10920, // Seguridad → REDES
};

const DEFAULT_TAXON_ID = 10920; // REDES (default)

export function mapCategory(odooCategId: number): number {
  return CATEGORY_MAP[odooCategId] ?? DEFAULT_TAXON_ID;
}
