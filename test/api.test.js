'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

let server, base, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgsched-'));
  const app = createApp({ dataDir, passcode: '', maxUploadMb: 1 });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const j = (method, url, body) =>
  fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

test('default event types are seeded', async () => {
  const r = await j('GET', '/api/types');
  assert.equal(r.status, 200);
  assert.ok(r.body.some((t) => t.label_ja === '経営会議'));
  assert.ok(r.body.some((t) => t.label_ja === 'バイオガス委員会'));
});

test('members: create JP and IN, soft delete hides from default list', async () => {
  const jp = await j('POST', '/api/members', { name: '山田 太郎', name_en: 'Taro Yamada', side: 'JP' });
  const ind = await j('POST', '/api/members', { name: 'Priya Sharma', side: 'IN' });
  assert.equal(jp.status, 201); assert.equal(ind.status, 201);
  const bad = await j('POST', '/api/members', { name: '' });
  assert.equal(bad.status, 400);
  const del = await j('DELETE', `/api/members/${ind.body.id}`);
  assert.equal(del.status, 200);
  const list = await j('GET', '/api/members');
  assert.ok(!list.body.some((m) => m.id === ind.body.id));
  const all = await j('GET', '/api/members?all=1');
  assert.ok(all.body.some((m) => m.id === ind.body.id && m.active === 0));
  await j('PUT', `/api/members/${ind.body.id}`, { active: true });
});

test('events: create, validate, filter, update, delete', async () => {
  const members = (await j('GET', '/api/members')).body;
  const jp = members.find((m) => m.side === 'JP');
  const ind = members.find((m) => m.side === 'IN');
  const types = (await j('GET', '/api/types')).body;
  const mgmt = types.find((t) => t.key === 'management');

  const created = await j('POST', '/api/events', {
    title: '経営会議', title_en: 'Management Meeting', type_id: mgmt.id,
    start_at: '2026-10-05T01:00:00Z', end_at: '2026-10-05T03:00:00Z', timezone: 'Asia/Tokyo',
    owner_id: jp.id, member_ids: [ind.id], status: 'confirmed',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.owner_name, '山田 太郎');
  assert.equal(created.body.members.length, 1);
  assert.equal(created.body.type_label_en, 'Management Meeting');

  const invalid = await j('POST', '/api/events', { title: 'x', type_id: mgmt.id, start_at: '2026-10-05T03:00:00Z', end_at: '2026-10-05T01:00:00Z' });
  assert.equal(invalid.status, 400); assert.equal(invalid.body.error, 'end_before_start');
  const noTitle = await j('POST', '/api/events', { type_id: mgmt.id, start_at: '2026-10-05T03:00:00Z' });
  assert.equal(noTitle.status, 400);

  // side filter matches owner side and participant side
  assert.equal((await j('GET', '/api/events?side=JP')).body.length, 1);
  assert.equal((await j('GET', '/api/events?side=IN')).body.length, 1);
  assert.equal((await j('GET', '/api/events?from=2026-11-01T00:00:00Z')).body.length, 0);
  assert.equal((await j('GET', '/api/events?q=Management')).body.length, 1);

  const updated = await j('PUT', `/api/events/${created.body.id}`, { status: 'done', member_ids: [] });
  assert.equal(updated.status, 200); assert.equal(updated.body.status, 'done'); assert.equal(updated.body.members.length, 0);

  const del = await j('DELETE', `/api/events/${created.body.id}`);
  assert.equal(del.status, 200);
  assert.equal((await j('GET', `/api/events/${created.body.id}`)).status, 404);
});

test('materials: upload file (UTF-8 name), add link, download, delete cascades with event', async () => {
  const types = (await j('GET', '/api/types')).body;
  const ev = (await j('POST', '/api/events', { title: '講演会', type_id: types[0].id, start_at: '2026-10-10T00:00:00Z', all_day: true })).body;

  const fd = new FormData();
  fd.append('file', new Blob(['hello agenda'], { type: 'text/plain' }), '議事録.txt');
  const up = await fetch(`${base}/api/events/${ev.id}/materials/upload`, { method: 'POST', body: fd });
  assert.equal(up.status, 201);
  const file = await up.json();
  assert.equal(file.name, '議事録.txt');
  assert.ok(fs.existsSync(path.join(dataDir, 'uploads', file.stored_name)));

  const link = await j('POST', `/api/events/${ev.id}/materials/link`, { url: 'https://example.com/x', name: 'SharePoint' });
  assert.equal(link.status, 201);
  const badLink = await j('POST', `/api/events/${ev.id}/materials/link`, { url: 'javascript:alert(1)' });
  assert.equal(badLink.status, 400);

  const dl = await fetch(`${base}/api/materials/${file.id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'hello agenda');
  assert.match(dl.headers.get('content-disposition'), /filename\*=UTF-8''%E8%AD%B0/);

  const detail = (await j('GET', `/api/events/${ev.id}`)).body;
  assert.equal(detail.materials.length, 2);

  const big = new FormData();
  big.append('file', new Blob([Buffer.alloc(1.5 * 1024 * 1024)]), 'big.bin');
  const tooBig = await fetch(`${base}/api/events/${ev.id}/materials/upload`, { method: 'POST', body: big });
  assert.equal(tooBig.status, 413);

  await j('DELETE', `/api/events/${ev.id}`);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', file.stored_name)));
  assert.equal((await j('GET', `/api/materials/${file.id}/download`)).status, 404);
});

test('ics feed lists non-cancelled events', async () => {
  const types = (await j('GET', '/api/types')).body;
  await j('POST', '/api/events', { title: '来客対応', title_en: 'Visitor', type_id: types[0].id, start_at: '2026-12-01T02:00:00Z', end_at: '2026-12-01T04:00:00Z' });
  await j('POST', '/api/events', { title: '中止イベント', type_id: types[0].id, start_at: '2026-12-02T02:00:00Z', status: 'cancelled' });
  const r = await fetch(`${base}/calendar.ics?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  const body = await r.text();
  assert.match(body, /BEGIN:VEVENT/);
  assert.match(body, /SUMMARY:\[Management Meeting\] Visitor/);
  assert.doesNotMatch(body, /中止イベント/);
});

test('passcode auth protects API and login sets cookie', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgsched-auth-'));
  const app = createApp({ dataDir: dir, passcode: 'secret123', secret: 's' });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const b = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(`${b}/api/events`)).status, 401);
    assert.equal((await fetch(`${b}/`)).status, 401);
    const bad = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: 'nope' }) });
    assert.equal(bad.status, 403);
    const ok = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: 'secret123' }) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${b}/api/events`, { headers: { cookie } })).status, 200);
  } finally {
    await new Promise((r) => srv.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
