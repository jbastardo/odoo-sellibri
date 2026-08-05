import { config } from 'dotenv';
config();
import { execute } from './src/odoo.js';
async function run() {
  const fields = await execute('product.product', 'fields_get', [], { attributes: ['type'] });
  console.log(Object.keys(fields).filter(k => k.includes('image')));
}
run();
