import { config } from 'dotenv';
config();
import { execute } from '../src/odoo';

async function test() {
  console.log('Querying product.product...');
  const products = await execute('product.product', 'search_read', [[['default_code', '=', '061552']]], {
    fields: ['name', 'display_name', 'product_tmpl_id']
  });
  console.log('Product.product:', products);

  if (products && products.length > 0 && products[0].product_tmpl_id) {
    const tmplId = products[0].product_tmpl_id[0];
    console.log('\nQuerying product.template for ID', tmplId);
    const tmpls = await execute('product.template', 'read', [[tmplId]], {
      fields: ['name', 'display_name', 'website_meta_title']
    });
    console.log('Product.template:', tmpls);
  }
}
test().catch(console.error);
