// Odoo categ_id → Sellibri taxon_id mapping
const CATEGORY_MAP: Record<number, number> = {
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

const DEFAULT_TAXON_ID = 8318; // OTROS

export function mapCategory(odooCategId: number): number {
  return CATEGORY_MAP[odooCategId] ?? DEFAULT_TAXON_ID;
}
