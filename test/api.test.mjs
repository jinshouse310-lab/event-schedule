import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlobsServer } from '@netlify/blobs/server';
import { setEnvironmentContext } from '@netlify/blobs';
import { createHandler } from '../src/app.mjs';

let blobs, dir, handler, cookie;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgsched-'));
  blobs = new BlobsServer({ directory: dir, token: 't' });
  const { port } = await blobs.start();
  const edgeURL = `http://127.0.0.1:${port}`;
  setEnvironmentContext({ edgeURL, uncachedEdgeURL: edgeURL, siteID: 'test-site', token: 't' });
  handler = createHandler({ passcode: 'team-pass', maxUploadMb: 1 });
  const login = await handler(new Request('http://localhost/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: 'team-pass' }) }));
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => { await blobs.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (method, url, body, headers = {}) => {
  const init = { method, headers: { cookie, ...headers } };
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
  const jp = await call('POST', '/api/members', { name: '山田 太郎', name_en: 'Taro Yamada', side: 'JP', dept: '経営企画部' });
  assert.equal(jp.body.dept, '経営企画部');
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
  assert.equal(created.body.owner_side, 'JP'); assert.equal(created.body.owner_dept, '経営企画部');
  assert.equal(created.body.members.length, 1);
  assert.equal(created.body.type_label_en, 'Management Meeting');

  const invalid = await call('POST', '/api/events', { title: 'x', type_id: mgmt.id, start_at: '2026-10-05T03:00:00Z', end_at: '2026-10-05T01:00:00Z' });
  assert.equal(invalid.status, 400); assert.equal(invalid.body.error, 'end_before_start');
  assert.equal((await call('POST', '/api/events', { type_id: mgmt.id, start_at: '2026-10-05T03:00:00Z' })).status, 400);
  assert.equal((await call('POST', '/api/events', { title: 'x', type_id: 'nope', start_at: '2026-10-05T03:00:00Z' })).body.error, 'invalid_type');

  // Owner can be a side only (person not decided yet)
  const sideOnly = await call('POST', '/api/events', { title: '来客', type_id: mgmt.id, start_at: '2026-10-06T01:00:00Z', owner_side: 'IN' });
  assert.equal(sideOnly.status, 201); assert.equal(sideOnly.body.owner_id, null); assert.equal(sideOnly.body.owner_side, 'IN'); assert.equal(sideOnly.body.owner_name, null);
  assert.equal((await call('GET', '/api/events?side=IN')).body.length, 2);
  // Assigning a person overrides the side-only owner; clearing the person keeps the given side
  const withPerson = await call('PUT', `/api/events/${sideOnly.body.id}`, { owner_id: jp.id, owner_side: 'IN' });
  assert.equal(withPerson.body.owner_side, 'JP');
  const cleared = await call('PUT', `/api/events/${sideOnly.body.id}`, { owner_id: null, owner_side: 'IN' });
  assert.equal(cleared.body.owner_id, null); assert.equal(cleared.body.owner_side, 'IN');
  assert.equal((await call('POST', '/api/events', { title: 'x', type_id: mgmt.id, start_at: '2026-10-06T01:00:00Z', owner_side: 'XX' })).body.owner_side, null);
  await call('DELETE', `/api/events/${sideOnly.body.id}`);
  const ics = await call('GET', '/calendar.ics');
  assert.doesNotMatch(ics.text, /主担当: インド側/);
  assert.equal((await call('GET', '/api/events?side=JP')).body.length, 1);
  assert.equal((await call('GET', '/api/events?side=IN')).body.length, 1);
  // member filter matches owner or involved member; owner filter matches owner only
  assert.equal((await call('GET', `/api/events?member=${jp.id}`)).body.length, 1);
  assert.equal((await call('GET', `/api/events?member=${ind.id}`)).body.length, 1);
  assert.equal((await call('GET', `/api/events?owner=${ind.id}`)).body.length, 0);
  assert.equal((await call('GET', '/api/events?member=nobody')).body.length, 0);
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
  const listed = (await call('GET', '/api/events')).body.find((e) => e.id === ev.id);
  assert.equal(listed.materials_count, 2);
  assert.equal(listed.materials.length, 2);
  assert.equal(listed.materials.find((m) => m.kind === 'link').url, 'https://example.com/x');

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
  await call('POST', '/api/events', { title: '拠点担当', title_en: 'Side owner', type_id: types[0].id, start_at: '2026-12-03T02:00:00Z', owner_side: 'IN' });
  const r = await call('GET', '/calendar.ics?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  assert.match(r.text, /SUMMARY:\[Management Meeting\] Visitor/);
  assert.doesNotMatch(r.text, /中止イベント/);
  assert.match(r.text, /DESCRIPTION:Owner: India/);
  assert.match((await call('GET', '/calendar.ics')).text, /DESCRIPTION:主担当: インド側/);
  const viaFn = await call('GET', '/.netlify/functions/api/calendar.ics?lang=en');
  assert.equal(viaFn.status, 200); assert.match(viaFn.text, /BEGIN:VEVENT/);
  assert.equal((await call('GET', '/.netlify/functions/api/events')).status, 200);
});

test('passcode auth: unconfigured refuses, login sets cookie, ICS key works without cookie', async () => {
  const none = createHandler({ passcode: '' });
  const r503 = await none(new Request('http://localhost/api/events'));
  assert.equal(r503.status, 503); assert.equal((await r503.json()).error, 'passcode_not_configured');
  const authInfo = await (await none(new Request('http://localhost/api/auth'))).json();
  assert.deepEqual(authInfo, { required: true, configured: false, authed: false, secretConfigured: false, secretUnlocked: false });
  assert.equal((await none(new Request('http://localhost/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"passcode":"x"}' }))).status, 503);

  const h = createHandler({ passcode: 'secret123' }); // no SESSION_SECRET: derived from passcode
  const c = async (method, url, body, headers) => {
    const init = { method, headers: { ...headers } };
    if (body) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    return h(new Request('http://localhost' + url, init));
  };
  assert.equal((await c('GET', '/api/events')).status, 401);
  assert.equal((await c('GET', '/calendar.ics')).status, 401);
  assert.equal((await c('GET', '/api/config')).status, 200);
  assert.equal((await (await c('GET', '/api/config')).json()).icsKey, undefined);
  assert.equal((await c('POST', '/api/login', { passcode: 'nope' })).status, 403);
  const ok = await c('POST', '/api/login', { passcode: 'secret123' });
  assert.equal(ok.status, 200);
  const ck = ok.headers.get('set-cookie').split(';')[0];
  assert.doesNotMatch(ok.headers.get('set-cookie'), /Secure/);
  assert.equal((await c('GET', '/api/events', null, { cookie: ck })).status, 200);
  assert.deepEqual(await (await c('GET', '/api/auth', null, { cookie: ck })).json(), { required: true, configured: true, authed: true, secretConfigured: false, secretUnlocked: false });
  const cfg = await (await c('GET', '/api/config', null, { cookie: ck })).json();
  assert.ok(cfg.icsKey && cfg.icsKey.length >= 20);
  // Same passcode in a fresh handler instance (new function invocation) yields the same cookie and key.
  const h2 = createHandler({ passcode: 'secret123' });
  assert.equal((await h2(new Request('http://localhost/api/events', { headers: { cookie: ck } }))).status, 200);
  assert.equal((await h2(new Request(`http://localhost/calendar.ics?key=${cfg.icsKey}&lang=en`))).status, 200);
  assert.equal((await h2(new Request('http://localhost/calendar.ics?key=wrong'))).status, 401);
  assert.equal((await h2(new Request(`http://localhost/api/events?key=${cfg.icsKey}`))).status, 401);
  const https = await h(new Request('https://example.netlify.app/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: 'secret123' }) }));
  assert.match(https.headers.get('set-cookie'), /Secure/);
  // Changing the passcode invalidates old cookies.
  const h3 = createHandler({ passcode: 'rotated' });
  assert.equal((await h3(new Request('http://localhost/api/events', { headers: { cookie: ck } }))).status, 401);
});

test('confidential events are visible only with the confidential passcode', async () => {
  const h = createHandler({ passcode: 'team', secretPasscode: 'top-secret' });
  const c = async (method, url, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const res = await h(new Request('http://localhost' + url, init));
    const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch {}
    return { status: res.status, body: j, text, headers: res.headers };
  };
  const login = await c('POST', '/api/login', { passcode: 'team' });
  const base = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await c('GET', '/api/auth', null, { cookie: base })).body.secretUnlocked, false);
  assert.equal((await c('POST', '/api/secret/login', { passcode: 'nope' }, { cookie: base })).status, 403);
  assert.equal((await c('POST', '/api/secret/login', { passcode: 'top-secret' })).status, 401); // needs site login first
  const sl = await c('POST', '/api/secret/login', { passcode: 'top-secret' }, { cookie: base });
  assert.equal(sl.status, 200);
  const both = base + '; ' + sl.headers.get('set-cookie').split(';')[0];
  assert.equal((await c('GET', '/api/auth', null, { cookie: both })).body.secretUnlocked, true);

  const types = (await c('GET', '/api/types', null, { cookie: base })).body;
  // locked users cannot create confidential events
  assert.equal((await c('POST', '/api/events', { title: 'x', type_id: types[0].id, start_at: '2027-05-01T00:00:00Z', confidential: true }, { cookie: base })).status, 403);
  const sec = await c('POST', '/api/events', { title: '極秘 M&A', type_id: types[0].id, start_at: '2027-05-01T01:00:00Z', confidential: true }, { cookie: both });
  assert.equal(sec.status, 201); assert.equal(sec.body.confidential, true);
  const link = await c('POST', `/api/events/${sec.body.id}/materials/link`, { url: 'https://example.com/secret' }, { cookie: both });
  assert.equal(link.status, 201);

  // without the secret cookie the event does not exist anywhere
  assert.ok(!(await c('GET', '/api/events', null, { cookie: base })).body.some((e) => e.id === sec.body.id));
  assert.equal((await c('GET', `/api/events/${sec.body.id}`, null, { cookie: base })).status, 404);
  assert.equal((await c('PUT', `/api/events/${sec.body.id}`, { title: 'hack' }, { cookie: base })).status, 404);
  assert.equal((await c('DELETE', `/api/events/${sec.body.id}`, null, { cookie: base })).status, 404);
  assert.equal((await c('POST', `/api/events/${sec.body.id}/materials/link`, { url: 'https://a.b' }, { cookie: base })).status, 404);
  assert.equal((await c('DELETE', `/api/materials/${sec.body.id}/${link.body.id}`, null, { cookie: base })).status, 404);
  assert.doesNotMatch((await c('GET', '/calendar.ics', null, { cookie: both })).text, /M&A/);
  // with it, everything works; locking again hides it
  assert.ok((await c('GET', '/api/events', null, { cookie: both })).body.some((e) => e.id === sec.body.id));
  assert.equal((await c('PUT', `/api/events/${sec.body.id}`, { location: '本社' }, { cookie: both })).status, 200);
  const out = await c('POST', '/api/secret/logout', null, { cookie: both });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  // handler without SECRET_PASSCODE: confidential events stay hidden from everyone
  const h2 = createHandler({ passcode: 'team' });
  const r = await h2(new Request('http://localhost/api/events', { headers: { cookie: both } }));
  assert.ok(!(await r.json()).some((e) => e.id === sec.body.id));
  assert.equal((await c('DELETE', `/api/events/${sec.body.id}`, null, { cookie: both })).status, 200);
});

test('side names are editable via settings', async () => {
  const d = (await call('GET', '/api/settings')).body;
  assert.equal(d.sides.JP.label_ja, '日本側'); assert.equal(d.sides.IN.short, 'IN');
  const r = await call('PUT', '/api/settings', { sides: { JP: { label_ja: 'SMC', label_en: 'SMC (Japan)', short: 'SMC' }, IN: { label_ja: 'MSIL', label_en: 'Maruti Suzuki', short: 'MSILXXXX' } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.sides.JP.label_ja, 'SMC'); assert.equal(r.body.sides.IN.short, 'MSILXX'); // short is capped at 6 chars
  assert.equal((await call('GET', '/api/settings')).body.sides.IN.label_en, 'Maruti Suzuki');
  const partial = await call('PUT', '/api/settings', { sides: { JP: { label_ja: '' } } });
  assert.equal(partial.body.sides.JP.label_ja, 'SMC'); // empty keeps the current value
  await call('PUT', '/api/settings', { sides: { JP: { label_ja: '日本側', label_en: 'Japan', short: 'JP' }, IN: { label_ja: 'インド側', label_en: 'India', short: 'IN' } } });
});
