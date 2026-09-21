import { createHmac, timingSafeEqual } from 'node:crypto';
import { createStore, newId, nowIso } from './store.mjs';
import { buildIcs } from './ics.mjs';

const COOKIE = 'bgsched';
const STATUSES = new Set(['planned', 'confirmed', 'done', 'cancelled']);

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const err = (code, status) => json({ error: code }, status);
const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));
const toIso = (s) => new Date(s).toISOString();
const str = (v) => String(v ?? '').trim();
const ok6 = (c) => /^#[0-9a-f]{6}$/i.test(c || '');

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * Creates a fetch-style handler `(Request) => Promise<Response>` used by both the
 * Netlify Function and the local dev server.
 */
export function createHandler({ passcode = '', secret = 'change-me', maxUploadMb = 4 } = {}) {
  const authEnabled = Boolean(passcode);
  const token = authEnabled ? createHmac('sha256', secret).update('ok:' + passcode).digest('base64url') : '';
  maxUploadMb = Number(maxUploadMb) || 4;

  const isAuthed = (req) => !authEnabled || safeEq(parseCookies(req.headers.get('cookie'))[COOKIE] || '', token);

  async function readJson(req) {
    try { return (await req.json()) || {}; } catch { return null; }
  }

  // ---------- members ----------
  async function memberHandlers(store, req, id, url) {
    if (req.method === 'GET' && !id) {
      const all = await store.getMembers();
      return json(url.searchParams.get('all') === '1' ? all : all.filter((m) => m.active));
    }
    if (req.method === 'POST' && !id) {
      const b = await readJson(req); if (!b) return err('invalid_json', 400);
      const name = str(b.name); if (!name) return err('name_required', 400);
      const m = { id: newId(), name, name_en: str(b.name_en), side: b.side === 'IN' ? 'IN' : 'JP', email: str(b.email), role: str(b.role), active: 1, created_at: nowIso() };
      return json(await store.putDoc('members', m.id, m), 201);
    }
    if (!id) return err('not_found', 404);
    const cur = await store.getDoc('members', id); if (!cur) return err('not_found', 404);
    if (req.method === 'PUT') {
      const b = await readJson(req); if (!b) return err('invalid_json', 400);
      const name = b.name !== undefined ? str(b.name) : cur.name; if (!name) return err('name_required', 400);
      const m = { ...cur, name,
        name_en: b.name_en !== undefined ? str(b.name_en) : cur.name_en,
        side: b.side === 'IN' || b.side === 'JP' ? b.side : cur.side,
        email: b.email !== undefined ? str(b.email) : cur.email,
        role: b.role !== undefined ? str(b.role) : cur.role,
        active: b.active !== undefined ? (b.active ? 1 : 0) : cur.active };
      return json(await store.putDoc('members', id, m));
    }
    if (req.method === 'DELETE') { await store.putDoc('members', id, { ...cur, active: 0 }); return json({ ok: true }); }
    return err('method_not_allowed', 405);
  }

  // ---------- types ----------
  async function typeHandlers(store, req, id, url) {
    const types = await store.getTypes();
    if (req.method === 'GET' && !id) return json(url.searchParams.get('all') === '1' ? types : types.filter((t) => t.active));
    if (req.method === 'POST' && !id) {
      const b = await readJson(req); if (!b) return err('invalid_json', 400);
      const label_ja = str(b.label_ja); if (!label_ja) return err('label_required', 400);
      const label_en = str(b.label_en) || label_ja;
      let key = str(b.key || label_en).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'type';
      if (types.some((t) => t.id === key)) key = `${key}-${newId().slice(-4)}`;
      const t = { id: key, key, label_ja, label_en, color: ok6(b.color) ? b.color : '#5d6d7e', sort_order: Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 90, active: 1 };
      return json(await store.putDoc('types', t.id, t), 201);
    }
    if (!id) return err('not_found', 404);
    const cur = types.find((t) => t.id === id); if (!cur) return err('not_found', 404);
    if (req.method === 'PUT') {
      const b = await readJson(req); if (!b) return err('invalid_json', 400);
      const t = { ...cur,
        label_ja: b.label_ja !== undefined ? str(b.label_ja) || cur.label_ja : cur.label_ja,
        label_en: b.label_en !== undefined ? str(b.label_en) || cur.label_en : cur.label_en,
        color: ok6(b.color) ? b.color : cur.color,
        sort_order: Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : cur.sort_order,
        active: b.active !== undefined ? (b.active ? 1 : 0) : cur.active };
      return json(await store.putDoc('types', id, t));
    }
    if (req.method === 'DELETE') { await store.putDoc('types', id, { ...cur, active: 0 }); return json({ ok: true }); }
    return err('method_not_allowed', 405);
  }

  // ---------- events ----------
  function decorate(ev, types, members) {
    const t = types.find((x) => x.id === ev.type_id) || {};
    const owner = members.find((m) => m.id === ev.owner_id) || null;
    return { ...ev,
      type_key: t.key, type_label_ja: t.label_ja, type_label_en: t.label_en, type_color: t.color || '#5d6d7e',
      owner_name: owner?.name ?? null, owner_name_en: owner?.name_en ?? null, owner_side: owner?.side ?? null,
      members: (ev.member_ids || []).map((id) => members.find((m) => m.id === id)).filter(Boolean)
        .map((m) => ({ id: m.id, name: m.name, name_en: m.name_en, side: m.side })) };
  }
  async function loadEvent(store, id, types, members) {
    const ev = await store.getDoc('events', id);
    if (!ev) return null;
    const materials = await store.listDocs('materials', `${id}/`);
    materials.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { ...decorate(ev, types, members), materials };
  }
  async function validateEvent(b, cur, types, members) {
    const out = {};
    out.title = b.title !== undefined ? str(b.title) : cur?.title;
    if (!out.title) return { error: 'title_required' };
    out.title_en = b.title_en !== undefined ? str(b.title_en) : cur?.title_en ?? '';
    out.type_id = b.type_id !== undefined ? String(b.type_id) : cur?.type_id;
    if (!types.some((t) => t.id === out.type_id)) return { error: 'invalid_type' };
    const start = b.start_at !== undefined ? b.start_at : cur?.start_at;
    if (!isIso(start)) return { error: 'invalid_start' };
    out.start_at = toIso(start);
    const end = b.end_at !== undefined ? b.end_at : cur?.end_at;
    out.end_at = end && isIso(end) ? toIso(end) : null;
    if (out.end_at && out.end_at < out.start_at) return { error: 'end_before_start' };
    out.all_day = b.all_day !== undefined ? Boolean(b.all_day) : Boolean(cur?.all_day);
    out.timezone = b.timezone !== undefined ? String(b.timezone) : cur?.timezone ?? 'Asia/Tokyo';
    try { new Intl.DateTimeFormat('en', { timeZone: out.timezone }); } catch { return { error: 'invalid_timezone' }; }
    out.location = b.location !== undefined ? str(b.location) : cur?.location ?? '';
    out.description = b.description !== undefined ? String(b.description) : cur?.description ?? '';
    out.owner_id = b.owner_id !== undefined ? (b.owner_id ? String(b.owner_id) : null) : cur?.owner_id ?? null;
    if (out.owner_id && !members.some((m) => m.id === out.owner_id)) return { error: 'invalid_owner' };
    out.status = b.status !== undefined ? String(b.status) : cur?.status ?? 'planned';
    if (!STATUSES.has(out.status)) return { error: 'invalid_status' };
    if (b.member_ids !== undefined) {
      if (!Array.isArray(b.member_ids)) return { error: 'invalid_members' };
      out.member_ids = [...new Set(b.member_ids.map(String))].filter((id) => members.some((m) => m.id === id));
    } else out.member_ids = cur?.member_ids ?? [];
    return { value: out };
  }

  async function eventHandlers(store, req, id, url) {
    const [types, members] = await Promise.all([store.getTypes(), store.getMembers()]);
    if (req.method === 'GET' && !id) {
      const q = url.searchParams;
      const [events, materialKeys] = await Promise.all([store.listDocs('events'), store.listKeys('materials')]);
      const counts = {};
      for (const k of materialKeys) { const evId = k.split('/')[0]; counts[evId] = (counts[evId] || 0) + 1; }
      const from = isIso(q.get('from')) ? toIso(q.get('from')) : null;
      const to = isIso(q.get('to')) ? toIso(q.get('to')) : null;
      const text = str(q.get('q')).toLowerCase();
      const side = q.get('side');
      const list = events.map((ev) => ({ ...decorate(ev, types, members), materials_count: counts[ev.id] || 0 })).filter((ev) => {
        if (from && (ev.end_at || ev.start_at) < from) return false;
        if (to && ev.start_at >= to) return false;
        if (q.get('type') && ev.type_id !== q.get('type')) return false;
        if (q.get('owner') && ev.owner_id !== q.get('owner')) return false;
        if ((side === 'JP' || side === 'IN') && ev.owner_side !== side && !ev.members.some((m) => m.side === side)) return false;
        if (q.get('status') && STATUSES.has(q.get('status')) && ev.status !== q.get('status')) return false;
        if (text && ![ev.title, ev.title_en, ev.description, ev.location].some((s) => (s || '').toLowerCase().includes(text))) return false;
        return true;
      });
      list.sort((a, b) => a.start_at.localeCompare(b.start_at) || a.id.localeCompare(b.id));
      return json(list);
    }
    if (req.method === 'POST' && !id) {
      const b = await readJson(req); if (!b) return err('invalid_json', 400);
      const { error, value } = await validateEvent(b, null, types, members);
      if (error) return err(error, 400);
      const ev = { id: newId(), ...value, created_at: nowIso(), updated_at: nowIso() };
      await store.putDoc('events', ev.id, ev);
      return json(await loadEvent(store, ev.id, types, members), 201);
    }
    if (!id) return err('not_found', 404);
    if (req.method === 'GET') {
      const ev = await loadEvent(store, id, types, members);
      return ev ? json(ev) : err('not_found', 404);
    }
    const cur = await store.getDoc('events', id); if (!cur) return err('not_found', 404);
    if (req.method === 'PUT') {
      const b = await readJson(req); if (!b) return err('invalid_json', 400);
      const { error, value } = await validateEvent(b, cur, types, members);
      if (error) return err(error, 400);
      await store.putDoc('events', id, { ...cur, ...value, updated_at: nowIso() });
      return json(await loadEvent(store, id, types, members));
    }
    if (req.method === 'DELETE') {
      const keys = await store.listKeys('materials', `${id}/`);
      await Promise.all(keys.map((k) => Promise.all([store.delDoc('materials', k), store.delFile(k)])));
      await store.delDoc('events', id);
      return json({ ok: true });
    }
    return err('method_not_allowed', 405);
  }

  // ---------- materials ----------
  async function uploadHandler(store, req, eventId) {
    if (!(await store.getDoc('events', eventId))) return err('event_not_found', 404);
    let form;
    try { form = await req.formData(); } catch { return err('invalid_form', 400); }
    const file = form.get('file');
    if (!file || typeof file === 'string') return err('file_required', 400);
    if (file.size > maxUploadMb * 1024 * 1024) return json({ error: 'file_too_large', maxUploadMb }, 413);
    const name = str(form.get('name')) || file.name || 'file';
    const m = { id: newId(), event_id: eventId, kind: 'file', name, url: '', mime: file.type || 'application/octet-stream', size: file.size, uploaded_by: str(form.get('uploaded_by')), created_at: nowIso() };
    const key = `${eventId}/${m.id}`;
    await store.putFile(key, await file.arrayBuffer(), { name: m.name, mime: m.mime });
    await store.putDoc('materials', key, m);
    return json(m, 201);
  }
  async function linkHandler(store, req, eventId) {
    if (!(await store.getDoc('events', eventId))) return err('event_not_found', 404);
    const b = await readJson(req); if (!b) return err('invalid_json', 400);
    const link = str(b.url);
    if (!/^https?:\/\//i.test(link)) return err('invalid_url', 400);
    const m = { id: newId(), event_id: eventId, kind: 'link', name: str(b.name) || link, url: link, mime: '', size: 0, uploaded_by: str(b.uploaded_by), created_at: nowIso() };
    await store.putDoc('materials', `${eventId}/${m.id}`, m);
    return json(m, 201);
  }
  async function downloadHandler(store, url, eventId, id) {
    const key = `${eventId}/${id}`;
    const m = await store.getDoc('materials', key);
    if (!m || m.kind !== 'file') return err('not_found', 404);
    const file = await store.getFile(key);
    if (!file) return err('file_missing', 410);
    const inline = url.searchParams.get('inline') === '1';
    return new Response(file.data, { status: 200, headers: {
      'content-type': m.mime || 'application/octet-stream',
      'content-length': String(file.data.byteLength),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(m.name)}`,
      'cache-control': 'private, max-age=0',
    } });
  }
  async function deleteMaterial(store, eventId, id) {
    const key = `${eventId}/${id}`;
    const m = await store.getDoc('materials', key);
    if (!m) return err('not_found', 404);
    await Promise.all([store.delDoc('materials', key), m.kind === 'file' ? store.delFile(key) : null]);
    return json({ ok: true });
  }

  // ---------- router ----------
  return async function handler(req) {
    const url = new URL(req.url);
    let path = url.pathname.replace(/\/+$/, '') || '/';
    const FN = '/.netlify/functions/api';
    if (path.startsWith(FN)) {
      // Rewritten form (/api/x -> /.netlify/functions/api/x): restore the /api prefix.
      path = path.slice(FN.length) || '/';
      if (!path.startsWith('/api/') && path !== '/calendar.ics') path = '/api' + path;
    }
    if (path === '/calendar.ics') path = '/api/calendar.ics';
    if (!path.startsWith('/api/')) return err('not_found', 404);
    const seg = path.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method;

    try {
      if (seg[0] === 'login' && method === 'POST') {
        if (!authEnabled) return json({ ok: true });
        const b = await readJson(req);
        if (!b || !safeEq(String(b.passcode || ''), passcode)) return err('bad_passcode', 403);
        const secure = url.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
        return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax;${secure ? ' Secure;' : ''} Max-Age=${60 * 60 * 24 * 90}` });
      }
      if (seg[0] === 'logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
      if (seg[0] === 'auth' && method === 'GET') return json({ required: authEnabled });
      if (seg[0] === 'config' && method === 'GET') return json({ maxUploadMb, authRequired: authEnabled });
      if (!isAuthed(req)) return err('unauthorized', 401);

      const store = createStore();
      if (seg[0] === 'calendar.ics' && method === 'GET') {
        const [types, members, events] = await Promise.all([store.getTypes(), store.getMembers(), store.listDocs('events')]);
        const body = buildIcs(events.map((e) => decorate(e, types, members)), url.searchParams.get('lang') === 'en' ? 'en' : 'ja');
        return new Response(body, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="biogas-events.ics"' } });
      }
      if (seg[0] === 'members' && seg.length <= 2) return memberHandlers(store, req, seg[1], url);
      if (seg[0] === 'types' && seg.length <= 2) return typeHandlers(store, req, seg[1], url);
      if (seg[0] === 'events' && seg.length <= 2) return eventHandlers(store, req, seg[1], url);
      if (seg[0] === 'events' && seg[2] === 'materials' && method === 'POST') {
        if (seg[3] === 'upload') return uploadHandler(store, req, seg[1]);
        if (seg[3] === 'link') return linkHandler(store, req, seg[1]);
      }
      if (seg[0] === 'materials' && seg.length === 4 && seg[3] === 'download' && method === 'GET') return downloadHandler(store, url, seg[1], seg[2]);
      if (seg[0] === 'materials' && seg.length === 3 && method === 'DELETE') return deleteMaterial(store, seg[1], seg[2]);
      return err('not_found', 404);
    } catch (e) {
      console.error(e);
      return err('internal_error', 500);
    }
  };
}
