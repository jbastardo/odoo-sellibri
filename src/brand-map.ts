/**
 * Maps Odoo brand names (lowercase) → Sellibri product_vendor_id.
 * Only brands that already exist as vendors in Sellibri are mapped.
 * Products with unmapped brands will have product_vendor_id = null.
 */
export const brandToVendorMap: Record<string, number> = {
  'agiler': 1421,
  'cdp': 1409,
  'fantech': 1389,
  'hikvision': 1352,
  'igoto': 1376,
  'ip-com': 1422,
  'logitech': 1387,
  'lucerna': 1377,
  'stc': 1364,
  'tp-link': 1357,
  'ubiquiti': 1392,
};

/** Get Sellibri vendor ID for an Odoo brand_id field */
export function mapBrandToVendor(brandId: [number, string] | false): number | null {
  if (!brandId || !Array.isArray(brandId)) return null;
  const brandName = brandId[1]?.trim().toLowerCase();
  if (!brandName) return null;
  return brandToVendorMap[brandName] ?? null;
}
