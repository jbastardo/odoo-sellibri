/**
 * Maps Odoo brand names (lowercase) → Sellibri product_vendor_id.
 * Currently no Odoo products have brand_id set, so this map is empty.
 * Add mappings as brands are configured in Odoo:
 *   'brand_name': vendor_id_from_sellibri
 *
 * Known Sellibri vendors (tutecnotienda.com):
 *   366619: APC, 366622: Forza, 366623: HP, 366624: Samsung,
 *   366628: Xiaomi, 366629: Dell, 366630: Supermicro, 366633: Epson,
 *   366635: Lenovo, 366638: Asus, 366643: Nexxt, 366646: Premiun
 */
export const brandToVendorMap: Record<string, number> = {
  // Currently empty — no Odoo products have brand_id set
  // When brands are added in Odoo, map them here:
  // 'samsung': 366624,
  // 'hp': 366623,
  // 'lenovo': 366635,
  // 'epson': 366633,
  // 'dell': 366629,
};

/** Get Sellibri vendor ID for an Odoo brand_id field */
export function mapBrandToVendor(brandId: [number, string] | false): number | null {
  if (!brandId || !Array.isArray(brandId)) return null;
  const brandName = brandId[1]?.trim().toLowerCase();
  if (!brandName) return null;
  return brandToVendorMap[brandName] ?? null;
}
