/**
 * Maps Odoo brand names (lowercase) → Sellibri product_vendor_id.
 * Currently no Odoo products have brand_id set, so this map is empty.
 * Add mappings as brands are configured in Odoo.
 */
export const brandToVendorMap: Record<string, number> = {
  // Add when Odoo products have brand_id configured:
  // 'hikvision': vendor_id,
  // 'tp-link': vendor_id,
};

/** Get Sellibri vendor ID for an Odoo brand_id field */
export function mapBrandToVendor(brandId: [number, string] | false): number | null {
  if (!brandId || !Array.isArray(brandId)) return null;
  const brandName = brandId[1]?.trim().toLowerCase();
  if (!brandName) return null;
  return brandToVendorMap[brandName] ?? null;
}
