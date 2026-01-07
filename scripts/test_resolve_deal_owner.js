#!/usr/bin/env node
// Script mínimo para simular a tool `resolve_deal_owner` localmente.
// Uso: TOKEN=<token> node scripts/test_resolve_deal_owner.js --deal_id=94766

const { argv, env } = require('process');
// ensure fetch is available in Node.js
try {
  if (typeof fetch === 'undefined') {
    global.fetch = require('node-fetch');
  }
} catch (_) {
  // ignore; package.json includes node-fetch
}

function argValue(name) {
  const p = argv.find((a) => a.startsWith(`--${name}=`));
  if (p) return p.split('=')[1];
  return undefined;
}

const TOKEN = env.TOKEN || argValue('token');
if (!TOKEN) {
  console.error('Falta TOKEN. Use TOKEN=<token> node scripts/test_resolve_deal_owner.js --deal_id=94766');
  process.exit(1);
}

const BASE = 'https://api.pipe.run/v1';

async function fetchJson(path) {
  const res = await fetch(BASE + path, { headers: { token: TOKEN } });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch (e) { return txt; }
}

function normalizeName(s) { return (s || '').toString().trim().toLowerCase(); }

(async function main(){
  const dealIdArg = argValue('deal_id');
  const dealTitleArg = argValue('deal_title');
  const pipelineNameArg = argValue('pipeline_name');
  const ownerNameArg = argValue('owner_name');

  console.error('Fetching pipelines and users...');
  const pipelinesResp = await fetchJson('/pipelines');
  const usersResp = await fetchJson('/users');

  const pipelines = Array.isArray(pipelinesResp?.data) ? pipelinesResp.data : (Array.isArray(pipelinesResp) ? pipelinesResp : []);
  const users = Array.isArray(usersResp?.data) ? usersResp.data : (Array.isArray(usersResp) ? usersResp : []);

  let pipelineId;
  let pipelineName = pipelineNameArg;
  if (pipelineNameArg) {
    const p = pipelines.find(x => normalizeName(x.name) === normalizeName(pipelineNameArg));
    if (p) pipelineId = p.id;
  }
  if (!pipelineName && pipelineId) {
    const p = pipelines.find(x => x.id === pipelineId);
    if (p) pipelineName = p.name;
  }

  let ownerId;
  let ownerName = ownerNameArg;
  if (ownerNameArg) {
    const u = users.find(x => normalizeName(x.name) === normalizeName(ownerNameArg));
    if (u) ownerId = u.id;
  }
  if (!ownerName && ownerId) {
    const u = users.find(x => x.id === ownerId);
    if (u) ownerName = u.name;
  }

  let deal = null;
  if (dealIdArg) {
    console.error('Fetching deal by id', dealIdArg);
    deal = await fetchJson(`/deals/${dealIdArg}`);
    deal = deal?.data ?? deal;
  } else if (dealTitleArg) {
    console.error('Listing deals to find by title...');
    const dealsResp = await fetchJson('/deals');
    const deals = Array.isArray(dealsResp?.data) ? dealsResp.data : (Array.isArray(dealsResp) ? dealsResp : []);
    const titleLower = normalizeName(dealTitleArg);
    let found = deals.find(d => normalizeName(d.title) === titleLower);
    if (!found) found = deals.find(d => normalizeName(d.title).includes(titleLower));
    if (!found && pipelineId) found = deals.find(d => d.pipeline_id === pipelineId && normalizeName(d.title).includes(titleLower));
    if (found) deal = found;
    if (!deal && ownerId) deal = deals.find(d => d.owner_id === ownerId) || null;
  } else if (pipelineId) {
    console.error('Listing deals for pipeline', pipelineId);
    const dealsResp = await fetchJson(`/deals?pipeline_id=${pipelineId}`);
    const deals = Array.isArray(dealsResp?.data) ? dealsResp.data : (Array.isArray(dealsResp) ? dealsResp : []);
    if (deals.length) deal = deals[0];
  } else if (ownerId) {
    console.error('Listing deals to find by owner', ownerId);
    const dealsResp = await fetchJson('/deals');
    const deals = Array.isArray(dealsResp?.data) ? dealsResp.data : (Array.isArray(dealsResp) ? dealsResp : []);
    deal = deals.find(d => d.owner_id === ownerId) || null;
  }

  if (!deal) {
    console.error('Nenhuma oportunidade encontrada com os parâmetros fornecidos.');
    process.exit(2);
  }

  const resolvedDeal = {
    id: deal.id ?? (deal.data && deal.data.id) ?? null,
    title: deal.title ?? (deal.data && deal.data.title) ?? null,
    pipeline_id: deal.pipeline_id ?? (deal.data && deal.data.pipeline_id) ?? null,
    owner_id: deal.owner_id ?? (deal.data && deal.data.owner_id) ?? null,
  };

  if (!pipelineName && resolvedDeal.pipeline_id) {
    const p = pipelines.find(x => x.id === resolvedDeal.pipeline_id);
    if (p) pipelineName = p.name;
  }
  if (!ownerName && resolvedDeal.owner_id) {
    const u = users.find(x => x.id === resolvedDeal.owner_id);
    if (u) ownerName = u.name;
  }

  console.log