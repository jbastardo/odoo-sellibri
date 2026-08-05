import { config } from 'dotenv';
config();
import { fetchProductBySku } from '../src/odoo';

async function test() {
  const p = await fetchProductBySku('061712');
  console.log('Product 061712:');
  console.log('- ID:', p?.id);
  console.log('- Name:', p?.name);
  console.log('- image_1920:', p?.image_1920);
  console.log('- tmpl_id:', p?.product_tmpl_id);
  
  const p2 = await fetchProductBySku('061552');
  console.log('\nProduct 061552:');
  console.log('- ID:', p2?.id);
  console.log('- Name:', p2?.name);
  console.log('- image_1920:', p2?.image_1920);
}
test().catch(console.error);
