import { config } from 'dotenv';
config();
import { execute, fetchProductMainImage } from './src/odoo.js';
import axios from 'axios';

async function run() {
  try {
    console.log('Fetching Odoo image...');
    const odooImg = await fetchProductMainImage(18265);
    if (!odooImg) {
      console.log('No image from Odoo');
      return;
    }
    const token = process.env.SELLIBRI_API_KEY;
    const store = process.env.SELLIBRI_STORE_HASH;
    
    const client = axios.create({
      baseURL: `https://api.sellibri.com/api/v2/storefront`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Store-Hash': store,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Fetching Sellibri product...');
    const res = await client.get('/products?filter[sku]=010265');
    const products = res.data.data;
    if (products.length === 0) { console.log('not found'); return; }
    const productId = products[0].id;
    console.log('Product ID:', productId);

    const patchData = {
      product: {
        master_attributes: {
          images_attributes: [{
            attachment: `data:image/jpeg;base64,${odooImg}`,
            position: 1
          }]
        }
      }
    };
    console.log('Patching with base64 attachment...');
    const resPatch = await client.patch(`/products/${productId}`, patchData);
    console.log('Patch success!', resPatch.status);
  } catch(e: any) {
    if (e.response) {
      console.log('ERROR:', e.response.status, JSON.stringify(e.response.data));
    } else {
      console.log('Error', e.message);
    }
  }
}
run();
