// SharePoint (Microsoft Graph) storage adapter.
// Same interface as the Netlify Blobs store: listKeys / listDocs / getDoc / putDoc / delDoc /
// putFile / getFile / delFile. Documents live in SharePoint lists with readable columns
// (SharePoint is the source of truth); files live in a document library, one folder per material.
//
// Required config: tenantId, clientId, clientSecret, siteUrl (https://<tenant>.sharepoint.com/sites/<site>).
// The app registration needs Microsoft Graph "Sites.Selected" with at least the "manage" role on the site
// (needed once to create the lists; "write" is enough afterwards).

const TEXT = { text: {} };
const NOTE = { text: { allowMultipleLines: true, textType: 'plain' } };
const BOOL = { boolean: {} };
const NUM = { number: {} };
const DATE = { dateTime: { format: 'dateTime' } };

const num = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));
const bool = (v) => v === true || v === 1 || v === 'true' || v === '1' || v === 'Yes';
const iso = (v) => (v ? new Date(v).toISOString() : null);
const parseJson = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

// Column names other than Title are our own (SharePoint internal names get created from these).
const LISTS = {
  members: {
    suffix: 'Members',
    columns: { Key: { ...TEXT, indexed: true }, NameEn: TEXT, Side: TEXT, Dept: TEXT, Email: TEXT, Role: TEXT, Active: BOOL, CreatedAt: TEXT },
    toFields: (d) => ({ Title: d.name || '', Key: d.id, NameEn: d.name_en || '', Side: d.side || 'JP', Dept: d.dept || '', Email: d.email || '', Role: d.role || '', Active: bool(d.active), CreatedAt: d.created_at || '' }),
    fromFields: (f) => ({ id: f.Key, name: f.Title || '', name_en: f.NameEn || '', side: f.Side === 'IN' ? 'IN' : 'JP', dept: f.Dept || '', email: f.Email || '', role: f.Role || '', active: bool(f.Active) ? 1 : 0, created_at: f.CreatedAt || '' }),
  },
  types: {
    suffix: 'EventTypes',
    columns: { Key: { ...TEXT, indexed: true }, LabelEn: TEXT, Color: TEXT, SortOrder: NUM, Active: BOOL },
    toFields: (d) => ({ Title: d.label_ja || '', Key: d.id, LabelEn: d.label_en || '', Color: d.color || '#5d6d7e', SortOrder: num(d.sort_order), Active: bool(d.active) }),
    fromFields: (f) => ({ id: f.Key, key: f.Key, label_ja: f.Title || '', label_en: f.LabelEn || '', color: f.Color || '#5d6d7e', sort_order: num(f.SortOrder), active: bool(f.Active) ? 1 : 0 }),
  },
  events: {
    suffix: 'Events',
    columns: { Key: { ...TEXT, indexed: true }, TitleEn: TEXT, TypeKey: TEXT, StartAt: DATE, EndAt: DATE, AllDay: BOOL, Timezone: TEXT, Location: TEXT, Description: NOTE, OwnerKey: TEXT, OwnerSide: TEXT, MemberKeys: NOTE, Status: TEXT, Confidential: BOOL, CreatedAt: TEXT, UpdatedAt: TEXT },
    toFields: (d) => ({ Title: d.title || '', Key: d.id, TitleEn: d.title_en || '', TypeKey: d.type_id || '', StartAt: iso(d.start_at), EndAt: iso(d.end_at), AllDay: bool(d.all_day), Timezone: d.timezone || 'Asia/Tokyo', Location: d.location || '', Description: d.description || '', OwnerKey: d.owner_id || '', OwnerSide: d.owner_side || '', MemberKeys: JSON.stringify(d.member_ids || []), Status: d.status || 'planned', Confidential: bool(d.confidential), CreatedAt: d.created_at || '', UpdatedAt: d.updated_at || '' }),
    fromFields: (f) => ({ id: f.Key, title: f.Title || '', title_en: f.TitleEn || '', type_id: f.TypeKey || '', start_at: iso(f.StartAt), end_at: iso(f.EndAt), all_day: bool(f.AllDay), timezone: f.Timezone || 'Asia/Tokyo', location: f.Location || '', description: f.Description || '', owner_id: f.OwnerKey || null, owner_side: f.OwnerSide || null, member_ids: parseJson(f.MemberKeys, []), status: f.Status || 'planned', confidential: bool(f.Confidential), created_at: f.CreatedAt || '', updated_at: f.UpdatedAt || '' }),
  },
  materials: {
    suffix: 'Materials',
    columns: { Key: { ...TEXT, indexed: true }, EventKey: { ...TEXT, indexed: true }, MaterialId: TEXT, Kind: TEXT, Url: NOTE, Mime: TEXT, Size: NUM, UploadedBy: TEXT, CreatedAt: TEXT },
    toFields: (d) => ({ Title: d.name || '', Key: `${d.event_id}/${d.id}`, EventKey: d.event_id, MaterialId: d.id, Kind: d.kind, Url: d.url || '', Mime: d.mime || '', Size: num(d.size), UploadedBy: d.uploaded_by || '', CreatedAt: d.created_at || '' }),
    fromFields: (f) => ({ id: f.MaterialId, event_id: f.EventKey, kind: f.Kind === 'link' ? 'link' : 'file', name: f.Title || '', url: f.Url || '', mime: f.Mime || '', size: num(f.Size), uploaded_by: f.UploadedBy || '', created_at: f.CreatedAt || '' }),
  },
  settings: {
    suffix: 'Settings',
    columns: { Key: { ...TEXT, indexed: true }, Json: NOTE },
    toFields: (d, key) => ({ Title: key, Key: key, Json: JSON.stringify(d) }),
    fromFields: (f) => parseJson(f.Json, null),
  },
};

export function createSharePointStore(cfg) {
  const fetchFn = cfg.fetch || globalThis.fetch;
  const graphBase = (cfg.graphBase || 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
  const loginBase = (cfg.loginBase || 'https://login.microsoftonline.com').replace(/\/$/, '');
  const prefix = cfg.listPrefix || 'Biogas';
  const libraryName = cfg.library || 'EventMaterials';
  for (const k of ['tenantId', 'clientId', 'clientSecret', 'siteUrl']) if (!cfg[k]) throw new Error(`SharePoint store: missing ${k}`);

  let tokenCache = { value: '', exp: 0 };
  async function token() {
    if (tokenCache.value && Date.now() < tokenCache.exp - 60000) return tokenCache.value;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: 'https://graph.microsoft.com/.default' });
    const res = await fetchFn(`${loginBase}/${cfg.tenantId}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(`SharePoint auth failed: ${res.status} ${data.error_description || data.error || ''}`);
    tokenCache = { value: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    return tokenCache.value;
  }

  async function graph(method, path, { body, headers = {}, raw = false, retry = 2 } = {}) {
    const url = path.startsWith('http') ? path : `${graphBase}${path}`;
    const init = { method, headers: { authorization: `Bearer ${await token()}`, ...headers } };
    if (body !== undefined) {
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) init.body = body;
      else { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    }
    if (raw) init.redirect = 'manual';
    const res = await fetchFn(url, init);
    if ((res.status === 429 || res.status === 503) && retry > 0) {
      const wait = Math.min(10000, (Number(res.headers.get('retry-after')) || 2) * 1000);
      await new Promise((r) => setTimeout(r, wait));
      return graph(method, path, { body, headers, raw, retry: retry - 1 });
    }
    if (raw) return res;
    if (res.status === 204) return null;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) { const e = new Error(`Graph ${method} ${path} -> ${res.status}: ${data?.error?.message || text}`); e.status = res.status; throw e; }
    return data;
  }

  // ---- site, lists and library (created on first use) ----
  let ids = null; // { siteId, lists: {name: listId}, driveId }
  let ensuring = null;
  async function ensure() {
    if (ids) return ids;
    if (!ensuring) ensuring = (async () => {
      const u = new URL(cfg.siteUrl);
      const site = await graph('GET', `/sites/${u.hostname}:${u.pathname.replace(/\/$/, '')}`);
      const siteId = site.id;
      const existing = (await graph('GET', `/sites/${siteId}/lists?$select=id,displayName,list`)).value || [];
      const byName = new Map(existing.map((l) => [l.displayName, l]));
      const lists = {};
      for (const [name, def] of Object.entries(LISTS)) {
        const displayName = `${prefix}${def.suffix}`;
        let list = byName.get(displayName);
        if (!list) {
          list = await graph('POST', `/sites/${siteId}/lists`, { body: {
            displayName, list: { template: 'genericList' },
            columns: Object.entries(def.columns).map(([colName, spec]) => ({ name: colName, ...spec })),
          } });
        }
        lists[name] = list.id;
      }
      let lib = byName.get(libraryName);
      if (!lib) lib = await graph('POST', `/sites/${siteId}/lists`, { body: { displayName: libraryName, list: { template: 'documentLibrary' } } });
      const drive = await graph('GET', `/sites/${siteId}/lists/${lib.id}/drive?$select=id`);
      ids = { siteId, lists, driveId: drive.id };
      return ids;
    })().catch((e) => { ensuring = null; throw e; });
    return ensuring;
  }

  // ---- list items ----
  const itemIds = new Map(); // `${name}:${key}` -> SharePoint item id
  const q = (s) => String(s).replace(/'/g, "''");
  async function items(name, filter) {
    const { siteId, lists } = await ensure();
    let url = `/sites/${siteId}/lists/${lists[name]}/items?$expand=fields&$top=500${filter ? `&$filter=${encodeURIComponent(filter)}` : ''}`;
    const out = [];
    while (url) {
      const page = await graph('GET', url, { headers: { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } });
      for (const it of page.value || []) { out.push(it); if (it.fields?.Key) itemIds.set(`${name}:${it.fields.Key}`, it.id); }
      url = page['@odata.nextLink'] || null;
    }
    return out;
  }
  async function findItem(name, key) {
    const hit = await items(name, `fields/Key eq '${q(key)}'`);
    return hit[0] || null;
  }
  async function listItemsByPrefix(name, prefix) {
    if (!prefix) return items(name);
    if (name === 'materials' && prefix.endsWith('/')) return items(name, `fields/EventKey eq '${q(prefix.slice(0, -1))}'`);
    return items(name, `startswith(fields/Key,'${q(prefix)}')`);
  }

  async function listKeys(name, prefix) { return (await listItemsByPrefix(name, prefix)).map((it) => it.fields.Key); }
  async function listDocs(name, prefix) { return (await listItemsByPrefix(name, prefix)).map((it) => LISTS[name].fromFields(it.fields)).filter(Boolean); }
  async function getDoc(name, key) { const it = await findItem(name, key); return it ? LISTS[name].fromFields(it.fields) : null; }
  async function putDoc(name, key, doc) {
    const { siteId, lists } = await ensure();
    const fields = LISTS[name].toFields(doc, key);
    let itemId = itemIds.get(`${name}:${key}`);
    if (!itemId) { const it = await findItem(name, key); itemId = it?.id; }
    if (itemId) {
      try { await graph('PATCH', `/sites/${siteId}/lists/${lists[name]}/items/${itemId}/fields`, { body: fields }); return doc; }
      catch (e) { if (e.status !== 404) throw e; itemIds.delete(`${name}:${key}`); }
    }
    const created = await graph('POST', `/sites/${siteId}/lists/${lists[name]}/items`, { body: { fields } });
    itemIds.set(`${name}:${key}`, created.id);
    return doc;
  }
  async function delDoc(name, key) {
    const { siteId, lists } = await ensure();
    const it = await findItem(name, key);
    if (!it) return;
    await graph('DELETE', `/sites/${siteId}/lists/${lists[name]}/items/${it.id}`);
    itemIds.delete(`${name}:${key}`);
  }

  // ---- files: library/<eventId>/<materialId>/<file name> ----
  const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|#%]/g, '_').slice(0, 120) || 'file';
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  async function putFile(key, data, metadata = {}) {
    const { driveId } = await ensure();
    const path = `${key}/${safeName(metadata.name)}`;
    const bytes = data instanceof ArrayBuffer ? data : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : await new Response(data).arrayBuffer();
    if (bytes.byteLength <= 4 * 1024 * 1024) {
      return graph('PUT', `/drives/${driveId}/root:/${enc(path)}:/content`, { body: bytes, headers: { 'content-type': metadata.mime || 'application/octet-stream' } });
    }
    const session = await graph('POST', `/drives/${driveId}/root:/${enc(path)}:/createUploadSession`, { body: { item: { '@microsoft.graph.conflictBehavior': 'replace' } } });
    const chunk = 8 * 1024 * 1024;
    let result = null;
    for (let off = 0; off < bytes.byteLength; off += chunk) {
      const end = Math.min(off + chunk, bytes.byteLength);
      const res = await fetchFn(session.uploadUrl, { method: 'PUT', headers: { 'content-length': String(end - off), 'content-range': `bytes ${off}-${end - 1}/${bytes.byteLength}` }, body: bytes.slice(off, end) });
      if (!res.ok) throw new Error(`Upload chunk failed: ${res.status}`);
      result = await res.json().catch(() => null);
    }
    return result;
  }
  async function getFile(key) {
    const { driveId } = await ensure();
    let children;
    try { children = (await graph('GET', `/drives/${driveId}/root:/${enc(key)}:/children?$select=id,name,file,size`)).value || []; }
    catch (e) { if (e.status === 404) return null; throw e; }
    const child = children.find((c) => c.file);
    if (!child) return null;
    const res = await graph('GET', `/drives/${driveId}/items/${child.id}/content`, { raw: true });
    let data;
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const dl = await fetchFn(res.headers.get('location')); // pre-authenticated URL: no bearer token
      if (!dl.ok) throw new Error(`Download failed: ${dl.status}`);
      data = await dl.arrayBuffer();
    } else if (res.ok) data = await res.arrayBuffer();
    else throw new Error(`Download failed: ${res.status}`);
    return { data, metadata: { name: child.name, mime: child.file?.mimeType || '' } };
  }
  async function delFile(key) {
    const { driveId } = await ensure();
    try { await graph('DELETE', `/drives/${driveId}/root:/${enc(key)}`); }
    catch (e) { if (e.status !== 404) throw e; }
  }

  return { listKeys, listDocs, getDoc, putDoc, delDoc, putFile, getFile, delFile, ensure, kind: 'sharepoint' };
}

export function sharePointConfigFromEnv(env = process.env) {
  return {
    tenantId: env.MS_TENANT_ID || '', clientId: env.MS_CLIENT_ID || '', clientSecret: env.MS_CLIENT_SECRET || '',
    siteUrl: env.SP_SITE_URL || '', listPrefix: env.SP_LIST_PREFIX || 'Biogas', library: env.SP_LIBRARY || 'EventMaterials',
    graphBase: env.MS_GRAPH_BASE || undefined, loginBase: env.MS_LOGIN_BASE || undefined,
  };
}
