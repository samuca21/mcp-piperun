#!/usr/bin/env node
const axios = require('axios');
// Lightweight arg parsing (no external deps)
const argv = process.argv.slice(2);
const getArg = (name) => {
  const p = argv.find((a) => a.startsWith(`--${name}=`));
  if (p) return p.split('=')[1];
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv.length > idx + 1) return argv[idx + 1];
  return undefined;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const token = getArg('token') || process.env.TOKEN || process.env.PIPERUN_API_TOKEN;
if (!token) {
  console.error('Missing token. Provide --token or set TOKEN/PIPERUN_API_TOKEN');
  process.exit(2);
}

const dealArg = getArg('deal_id');
const dealId = dealArg ? Number(dealArg) : (process.env.DEAL_ID ? Number(process.env.DEAL_ID) : 55317064);
const doCreate = hasFlag('create');

const BASE = 'https://api.pipe.run/v1';
const client = axios.create({ baseURL: BASE, headers: { token, 'Content-Type': 'application/json' } });

(async () => {
  try {
    console.log('Listing /proposals (first page)');
    const res = await client.get('/proposals', { params: { page: 1, show: 20 } });
    console.log(JSON.stringify(res.data, null, 2));

    if (dealId) {
      console.log(`\nListing /deals/${dealId}/proposals`);
      try {
        const r2 = await client.get(`/deals/${dealId}/proposals`, { params: { page: 1, show: 20 } });
        console.log(JSON.stringify(r2.data, null, 2));
      } catch (err) {
        console.error('Error listing proposals for deal:', err.response ? err.response.data : err.message);
      }
    }

    if (doCreate) {
      console.log('\nAttempting to create a sample proposal (this may fail depending on required fields)');
      const sample = {
        title: 'Teste de proposta (API)',
        description: 'Proposta de teste criada via API por script automatizado',
        deal_id: dealId
      };
      try {
        const r3 = await client.post('/proposals', sample);
        console.log('Create response:', JSON.stringify(r3.data, null, 2));
        const createdId = r3.data && (r3.data.id || (r3.data.data && r3.data.data.id));
        if (createdId) {
          console.log('Attempting to delete created proposal id=', createdId);
          const rdel = await client.delete(`/proposals/${createdId}`);
          console.log('Delete response:', JSON.stringify(rdel.data, null, 2));
        }
      } catch (err) {
        console.error('Create proposal error:', err.response ? err.response.data : err.message);
      }
    }

    console.log('\nDone');
  } catch (e) {
    console.error('Unexpected error:', e.response ? e.response.data : e.message);
    process.exit(1);
  }
})();
