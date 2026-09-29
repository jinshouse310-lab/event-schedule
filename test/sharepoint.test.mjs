import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeGraph } from './fake-graph.mjs';
import { createSharePointStore } from '../src/store-sharepoint.mjs';
import { resetStoreCache } from '../src/store.mjs';
import { createHandler } from '../src/app.mjs';

let fake, handler, cookie;
before(async () => {
  fake = await startFakeGraph();
  process.env.STORAGE = 'sharepoint';
  process.env.MS_TENANT_ID = 'tenant'; process.env.MS_CLIENT_ID = 'client'; process.env.MS_CLIENT_SECRET = 'secret';
  process.env.SP_SITE_URL = 'https://contoso.sharepoint.com/sites/biogas';
  process.env.MS_GRAPH_BASE = fake.graphBase; process.env.MS_LOGIN_BASE = fake.loginBase;
  resetStoreCache();
  handler = createHandler({ passcode: 'pw', maxUploadMb: 1 });
  const login = await handler(new Request('http://localhost/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: 'pw' }) }));
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => { delete process.env.STORAGE; resetStoreCache(); await fake.stop(); });

const call = async (method, url, body, headers = {}) => {
  const init = { method, headers: { cookie, ...headers } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  const res = await handler(new Request('http://localhost' + url, init));
  const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: res.status, body: j, text, headers: res.headers };
};

test('provisions lists and library on first use and seeds default types', async () => {
  const types = (await call('GET', '/api/types')).body;
  assert.ok(types.some((t) => t.label_ja === '経営会議'));
  const names = [...fake.state.lists.values()].map((l) => l.displayName).sort();
  assert.deepEqual(names, ['BiogasEventTypes', 'BiogasEvents', 'BiogasMaterials', 'BiogasMembers', 'BiogasSettings', 'EventMaterials']);
  const keyCol = [...fake.state.lists.values()].find((l) => l.displayName === 'BiogasEvents').columns.find((c) => c.name === 'Key');
  assert.equal(keyCol.indexed, true);
});

test('members and events round-trip through SharePoint list columns', async () => {
  const jp = (await call('POST', '/api/members', { name: '山田 太郎', name_en: 'Taro Yamada', side: 'JP', dept: '経営企画部' })).body;
  const ind = (await call('POST', '/api/members', { name: 'Priya Sharma', side: 'IN' })).body;
  const mgmt = (await call('GET', '/api/types')).body.find((t) => t.key === 'management');
  const created = await call('POST', '/api/events', {
    title: '経営会議', title_en: 'Management Meeting', type_id: mgmt.id, start_at: '2026-10-05T01:00:00Z', end_at: '2026-10-05T03:00:00Z',
    timezone: 'Asia/Tokyo', location: '東京本社', description: 'メモ\n2行目', owner_id: jp.id, member_ids: [ind.id], status: 'confirmed',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.owner_name, '山田 太郎'); assert.equal(created.body.owner_dept, '経営企画部');
  assert.equal(created.body.members[0].name, 'Priya Sharma');
  // stored as readable columns
  const row = [...fake.state.items.values()].find((it) => it.fields.Key === created.body.id);
  assert.equal(row.fields.Title, '経営会議'); assert.equal(row.fields.StartAt, '2026-10-05T01:00:00.000Z'); assert.equal(row.fields.Status, 'confirmed');
  assert.equal(row.fields.MemberKeys, JSON.stringify([ind.id])); assert.equal(row.fields.Confidential, false);
  // update, filters, get
  const upd = await call('PUT', `/api/events/${created.body.id}`, { status: 'done', end_at: null, all_day: true, start_at: '2026-10-06T00:00:00Z' });
  assert.equal(upd.body.status, 'done'); assert.equal(upd.body.end_at, null); assert.equal(upd.body.all_day, true);
  assert.equal((await call('GET', `/api/events?member=${ind.id}`)).body.length, 1);
  assert.equal((await call('GET', `/api/events?side=IN`)).body.length, 1);
  assert.equal((await call('GET', `/api/events/${created.body.id}`)).body.description, 'メモ\n2行目');
  // more than one page of items (fake pages are 2 rows)
  for (let i = 0; i < 4; i++) await call('POST', '/api/events', { title: `E${i}`, type_id: mgmt.id, start_at: `2026-11-0${i + 1}T00:00:00Z` });
  assert.equal((await call('GET', '/api/events')).body.length, 5);
  assert.equal((await call('DELETE', `/api/members/${ind.id}`)).status, 200);
  assert.equal((await call('GET', '/api/members')).body.length, 1);
});

test('materials: file upload into library folder, download via redirect, link, cascade delete', async () => {
  const types = (await call('GET', '/api/types')).body;
  const ev = (await call('POST', '/api/events', { title: '講演会', type_id: types[0].id, start_at: '2026-12-10T00:00:00Z', all_day: true })).body;
  const fd = new FormData();
  fd.append('file', new Blob(['hello agenda'], { type: 'text/plain' }), '議事録 2026.txt');
  const up = await call('POST', `/api/events/${ev.id}/materials/upload`, fd);
  assert.equal(up.status, 201); assert.equal(up.body.name, '議事録 2026.txt');
  const stored = [...fake.state.drive.values()][0];
  assert.equal(stored.path, `${ev.id}/${up.body.id}/議事録 2026.txt`);
  assert.equal((await call('POST', `/api/events/${ev.id}/materials/link`, { url: 'https://contoso.sharepoint.com/sites/biogas/x.pptx', name: 'アジェンダ' })).status, 201);
  const dl = await call('GET', `/api/materials/${ev.id}/${up.body.id}/download`);
  assert.equal(dl.status, 200); assert.equal(dl.text, 'hello agenda'); assert.match(dl.headers.get('content-disposition'), /filename\*=UTF-8''%E8%AD%B0/);
  const detail = (await call('GET', `/api/events/${ev.id}`)).body;
  assert.equal(detail.materials.length, 2);
  assert.equal((await call('GET', '/api/events')).body.find((e) => e.id === ev.id).materials_count, 2);
  assert.equal((await call('DELETE', `/api/materials/${ev.id}/${up.body.id}`)).status, 200);
  assert.equal(fake.state.drive.size, 0);
  assert.equal((await call('GET', `/api/events/${ev.id}`)).body.materials.length, 1);
  assert.equal((await call('DELETE', `/api/events/${ev.id}`)).status, 200);
  assert.equal([...fake.state.items.values()].filter((it) => it.fields.EventKey === ev.id).length, 0);
});

test('settings and ICS work on SharePoint', async () => {
  const r = await call('PUT', '/api/settings', { sides: { JP: { label_ja: 'SMC', label_en: 'SMC', short: 'SMC' } } });
  assert.equal(r.body.sides.JP.label_ja, 'SMC');
  assert.equal((await call('GET', '/api/settings')).body.sides.JP.short, 'SMC');
  const ics = await call('GET', '/calendar.ics');
  assert.equal(ics.status, 200); assert.match(ics.text, /BEGIN:VEVENT/);
});

test('storage check reports the SharePoint lists', async () => {
  const r = await call('GET', '/api/storage-check');
  assert.equal(r.status, 200); assert.equal(r.body.kind, 'sharepoint'); assert.deepEqual(r.body.lists.sort(), ['events', 'materials', 'members', 'settings', 'types']);
  assert.equal((await call('GET', '/api/config')).body.storage, 'sharepoint');
});

test('adapter retries on 429 and fails clearly without config', async () => {
  assert.throws(() => createSharePointStore({ tenantId: 't' }), /missing clientId/);
  let calls = 0;
  const store = createSharePointStore({ tenantId: 't', clientId: 'c', clientSecret: 's', siteUrl: 'https://contoso.sharepoint.com/sites/x', graphBase: fake.graphBase, loginBase: fake.loginBase,
    fetch: async (url, init) => { calls++; if (String(url).includes('/sites/contoso') && calls === 2) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } }); return fetch(url, init); } });
  const ids = await store.ensure();
  assert.equal(ids.siteId, 'site-1');
});
