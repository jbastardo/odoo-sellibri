import { config } from 'dotenv';
config();
import { execute } from './src/odoo.js';
async function run() {
  const products = await execute('product.product', 'search_read', [[['default_code', '=', '061712']]], {
    fields: ['name', 'image_128', 'image_1920', 'product_tmpl_id'],
  });
  const p = products[0];
  console.log("Name:", p.name);
  console.log("image_128 length:", typeof p.image_128 === 'string' ? p.image_128.length : p.image_128);
  console.log("image_1920 length:", typeof p.image_1920 === 'string' ? p.image_1920.length : p.image_1920);
}
run();
