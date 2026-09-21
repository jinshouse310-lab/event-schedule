import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlobsServer } from '@netlify/blobs/server';
import { setEnvironmentContext } from '@netlify/blobs';
import { createHandler } from '../src/app.mjs';

let blobs, dir, handler;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgsched-'));
  blobs = new BlobsServer({ directory: dir, token: 't' });
  const { port } = await blobs.start();
  const edgeURL = `http://127.0.0.1:${port}`;
  setEnvironmentContext({ edgeURL, uncachedEdgeURL: edgeURL, siteID: 'test-site', token: 't' });
  handler = createHandler({ passcode: '', maxUploadMb: 1 });
});
after(async () => { await blobs.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (method, url, body, headers = {}) => {
  const init = { method, headers: { ...headers } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  const res = await handler(new Request('http://localhost' + url, init));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text, headers: res.headers };
};

test('default event types are seeded', async () => {
  const r = await call('GET', '/api/types');
  assert.equal(r.status, 200);
  assert.ok(r.body.some((t) => t.label_ja === '経営会議'));
  assert.ok(r.body.some((t) => t.label_ja === 'バイオガス委員会'));
  const added = await call('POST', '/api/types', { label_ja: '監査', label_en: 'Audit', color: '#123456' });
  assert.equal(added.status, 201); assert.equal(added.body.id, 'audit');
  const dup = await call('POST', '/api/types', { label_ja: '監査2', label_en: 'Audit' });
  assert.equal(dup.status, 201); assert.notEqual(dup.body.id, 'audit');
});

test('members: create JP and IN, soft delete hides from default list', async () => {
  const jp = await call('POST', '/api/members', { name: '山田 太郎', name_en: 'Taro Yamada', side: 'JP' });
  const ind = await call('POST', '/api/members', { name: 'Priya Sharma', side: 'IN' });
  assert.equal(jp.status, 201); assert.equal(ind.status, 201);
  assert.equal((await call('POST', '/api/members', { name: '' })).status, 400);
  assert.equal((await call('DELETE', `/api/members/${ind.body.id}`)).status, 200);
  assert.ok(!(await call('GET', '/api/members')).body.some((m) => m.id === ind.body.id));
  assert.ok((await call('GET', '/api/members?all=1')).body.some((m) => m.id === ind.body.id && m.active === 0));
  assert.equal((await call('PUT', `/api/members/${ind.body.id}`, { active: true })).body.active, 1);
});

test('events: create, validate, filter, update, delete', async () => {
  const members = (await call('GET', '/api/members')).body;
  const jp = members.find((m) => m.side === 'JP'), ind = members.find((m) => m.side === 'IN');
  const mgmt = (await call('GET', '/api/types')).body.find((t) => t.key === 'management');

  const created = await call('POST', '/api/events', {
    title: '経営会議', title_en: 'Management Meeting', type_id: mgmt.id,
    start_at: '2026-10-05T01:00:00Z', end_at: '2026-10-05T03:00:00Z', timezone: 'Asia/Tokyo',
    owner_id: jp.id, member_ids: [ind.id], status: 'confirmed',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.owner_name, '山田 太郎');
  assert.equal(created.body.members.length, 1);
  assert.equal(created.body.type_label_en, 'Management Meeting');

  const invalid = await call('POST', '/api/events', { title: 'x', type_id: mgmt.id, start_at: '2026-10-05T03:00:00Z', end_at: '2026-10-05T01:00:00Z' });
  assert.equal(invalid.status, 400); assert.equal(invalid.body.error, 'end_before_start');
  assert.equal((await call('POST', '/api/events', { type_id: mgmt.id, start_at: '2026-10-05T03:00:00Z' })).status, 400);
  assert.equal((await call('POST', '/api/events', { title: 'x', type_id: 'nope', start_at: '2026-10-05T03:00:00Z' })).body.error, 'invalid_type');

  assert.equal((await call('GET', '/api/events?side=JP')).body.length, 1);
  assert.equal((await call('GET', '/api/events?side=IN')).body.length, 1);
  assert.equal((await call('GET', '/api/events?from=2026-11-01T00:00:00Z')).body.length, 0);
  assert.equal((await call('GET', '/api/events?q=management')).body.length, 1);
  assert.equal((await call('GET', '/api/events')).body[0].materials_count, 0);

  const updated = await call('PUT', `/api/events/${created.body.id}`, { status: 'done', member_ids: [] });
  assert.equal(updated.status, 200); assert.equal(updated.body.status, 'done'); assert.equal(updated.body.members.length, 0);
  assert.equal(updated.body.title, '経営会議');

  assert.equal((await call('DELETE', `/api/events/${created.body.id}`)).status, 200);
  assert.equal((await call('GET', `/api/events/${created.body.id}`)).status, 404);
});

test('materials: upload (UTF-8 name), link, download, size limit, cascade delete', async () => {
  const types = (await call('GET', '/api/types')).body;
  const ev = (await call('POST', '/api/events', { title: '講演会', type_id: types[0].id, start_at: '2026-10-10T00:00:00Z', all_day: true })).body;

  const fd = new FormData();
  fd.append('file', new Blob(['hello agenda'], { type: 'text/plain' }), '議事録.txt');
  const up = await call('POST', `/api/events/${ev.id}/materials/upload`, fd);
  assert.equal(up.status, 201); assert.equal(up.body.name, '議事録.txt'); assert.equal(up.body.size, 12);

  assert.equal((await call('POST', `/api/events/${ev.id}/materials/link`, { url: 'https://example.com/x', name: 'SharePoint' })).status, 201);
  assert.equal((await call('POST', `/api/events/${ev.id}/materials/link`, { url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await call('POST', `/api/events/nope/materials/link`, { url: 'https://a.b' })).status, 404);

  const dl = await call('GET', `/api/materials/${ev.id}/${up.body.id}/download`);
  assert.equal(dl.status, 200); assert.equal(dl.text, 'hello agenda');
  assert.match(dl.headers.get('content-disposition'), /filename\*=UTF-8''%E8%AD%B0/);

  const detail = (await call('GET', `/api/events/${ev.id}`)).body;
  assert.equal(detail.materials.length, 2);
  assert.equal((await call('GET', '/api/events')).body.find((e) => e.id === ev.id).materials_count, 2);

  const big = new FormData();
  big.append('file', new Blob([new Uint8Array(1.5 * 1024 * 1024)]), 'big.bin');
  assert.equal((await call('POST', `/api/events/${ev.id}/materials/upload`, big)).status, 413);

  assert.equal((await call('DELETE', `/api/materials/${ev.id}/${up.body.id}`)).status, 200);
  assert.equal((await call('GET', `/api/materials/${ev.id}/${up.body.id}/download`)).status, 404);
  assert.equal((await call('DELETE', `/api/events/${ev.id}`)).status, 200);
  assert.equal((await call('GET', `/api/events/${ev.id}`)).status, 404);
});

test('ics feed lists non-cancelled events, also via function rewrite path', async () => {
  const types = (await call('GET', '/api/types')).body;
  await call('POST', '/api/events', { title: '来客対応', title_en: 'Visitor', type_id: types[0].id, start_at: '2026-12-01T02:00:00Z', end_at: '2026-12-01T04:00:00Z' });
  await call('POST', '/api/events', { title: '中止イベント', type_id: types[0].id, start_at: '2026-12-02T02:00:00Z', status: 'cancelled' });
  const r = await call('GET', '/calendar.ics?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  assert.match(r.text, /SUMMARY:\[Management Meeting\] Visitor/);
  assert.doesNotMatch(r.text, /中止イベント/);
  const viaFn = await call('GET', '/.netlify/functions/api/calendar.ics?lang=en');
  assert.equal(viaFn.status, 200); assert.match(viaFn.text, /BEGIN:VEVENT/);
  assert.equal((await call('GET', '/.netlify/functions/api/events')).status, 200);
});

test('passcode auth protects API and login sets cookie', async () => {
  const h = createHandler({ passcode: 'secret123', secret: 's' });
  const c = async (method, url, body, headers) => {
    const init = { method, headers: { ...headers } };
    if (body) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    return h(new Request('http://localhost' + url, init));
  };
  assert.equal((await c('GET', '/api/events')).status, 401);
  assert.equal((await c('GET', '/calendar.ics')).status, 401);
  assert.equal((await c('GET', '/api/config')).status, 200);
  assert.equal((await c('POST', '/api/login', { passcode: 'nope' })).status, 403);
  const ok = await c('POST', '/api/login', { passcode: 'secret123' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.doesNotMatch(ok.headers.get('set-cookie'), /Secure/);
  assert.equal((await c('GET', '/api/events', null, { cookie })).status, 200);
  const https = await h(new Request('https://example.netlify.app/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: 'secret123' }) }));
  assert.match(https.headers.get('set-cookie'), /Secure/);
});
