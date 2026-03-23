import * as xmlrpc from 'xmlrpc';

async function main() {
  const authClient = xmlrpc.createSecureClient({ host: 'www.onprotec.shop', port: 443, path: '/xmlrpc/2/common' });
  const uid = await new Promise<number>((res, rej) => authClient.methodCall('authenticate', ['binaural-dev-onprotec-16-release-8815487', 'juan@onprotec.com', '9803', {}], (e, v) => e ? rej(e) : res(v)));
  const objClient = xmlrpc.createSecureClient({ host: 'www.onprotec.shop', port: 443, path: '/xmlrpc/2/object' });
  const exec = (model: string, method: string, args: any[], kw: any = {}) =>
    new Promise<any>((res, rej) => objClient.methodCall('execute_kw', ['binaural-dev-onprotec-16-release-8815487', uid, '9803', model, method, args, kw], (e, v) => e ? rej(e) : res(v)));

  // Get ALL fields of product.template that contain 'name' or 'title' or 'website'
  const fields = await exec('product.template', 'fields_get', [], { 
    attributes: ['string', 'type'] 
  });
  
  console.log('=== Fields containing "name", "title", or "website" ===');
  for (const [field, info] of Object.entries(fields) as any) {
    if (field.includes('name') || field.includes('title') || field.includes('website') || field.includes('seo')) {
      console.log(`  ${field}: type=${info.type} label="${info.string}"`);
    }
  }

  // Now read ALL name-related fields for template 75049
  console.log('\n=== Template 75049: all name/website fields ===');
  const nameFields = Object.keys(fields).filter((f: string) => 
    f.includes('name') || f.includes('title') || f.includes('website') || f.includes('seo')
  );
  
  try {
    const data = await exec('product.template', 'read', [[75049]], { fields: nameFields });
    for (const d of data) {
      for (const [key, val] of Object.entries(d)) {
        if (key === 'id') continue;
        const v = typeof val === 'string' ? val.substring(0, 100) : val;
        if (v && v !== false && v !== '') {
          console.log(`  ${key}: ${JSON.stringify(v)}`);
        }
      }
    }
  } catch (err: any) {
    console.log(`  Error: ${err.message?.substring(0, 200)}`);
    // Try without problematic fields
    const safeFields = nameFields.filter(f => !f.includes('website_name'));
    const data = await exec('product.template', 'read', [[75049]], { fields: safeFields });
    for (const d of data) {
      for (const [key, val] of Object.entries(d)) {
        if (key === 'id') continue;
        const v = typeof val === 'string' ? val.substring(0, 100) : val;
        if (v && v !== false && v !== '') {
          console.log(`  ${key}: ${JSON.stringify(v)}`);
        }
      }
    }
  }
}

main().catch(err => console.error(err.message));
