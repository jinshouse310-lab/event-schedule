#!/usr/bin/env node
// Copies all data from Netlify Blobs (current production storage) into SharePoint.
// Idempotent: documents are upserted by key, files are re-uploaded.
//
// Usage (from a PC with Node 20+):
//   NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... \
//   MS_TENANT_ID=... MS_CLIENT_ID=... MS_CLIENT_SECRET=... SP_SITE_URL=https://<tenant>.sharepoint.com/sites/<site> \
//   node scripts/migrate-blobs-to-sharepoint.mjs
//
// NETLIFY_SITE_ID: Site configuration > Site details > Site ID
// NETLIFY_AUTH_TOKEN: User settings > Applications > Personal access tokens
import { getStore } from '@netlify/blobs';
import { createSharePointStore, sharePointConfigFromEnv } from '../src/store-sharepoint.mjs';

const need = (k) => { if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); } return process.env[k]; };
const siteID = need('NETLIFY_SITE_ID'), token = need('NETLIFY_AUTH_TOKEN');
for (const k of ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'SP_SITE_URL']) need(k);

const blobs = (name) => getStore({ name, siteID, token, consistency: 'strong' });
const sp = createSharePointStore(sharePointConfigFromEnv());
await sp.ensure();
console.log('SharePoint lists ready.');

for (const name of ['types', 'members', 'events', 'materials', 'settings']) {
  const store = blobs(name);
  const { blobs: entries } = await store.list();
  let n = 0;
  for (const { key } of entries) {
    const doc = await store.get(key, { type: 'json' });
    if (!doc) continue;
    await sp.putDoc(name, key, doc);
    n++;
  }
  console.log(`${name}: ${n} copied`);
}

const files = blobs('files');
const { blobs: fileEntries } = await files.list();
let f = 0;
for (const { key } of fileEntries) {
  const got = await files.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!got) continue;
  await sp.putFile(key, got.data, got.metadata || {});
  f++;
  console.log(`  file ${key} (${got.metadata?.name || ''})`);
}
console.log(`files: ${f} copied`);
console.log('Done. Set STORAGE=sharepoint on Netlify and redeploy to switch over.');
