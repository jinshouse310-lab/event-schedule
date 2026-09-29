// Minimal in-memory fake of the Microsoft Graph endpoints used by src/store-sharepoint.mjs.
// Used by tests only. Supports: token, site lookup, lists (create/list), list items (CRUD with
// $filter on fields/Key, fields/EventKey and startswith(fields/Key)), drive upload/children/content/delete.
import http from 'node:http';

export async function startFakeGraph() {
  const state = { lists: new Map(), items: new Map(), nextId: 1, drive: new Map(), siteId: 'site-1', driveId: 'drive-1', requests: [] };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const matchFilter = (fields, filter) => {
    if (!filter) return true;
    let m = filter.match(/^fields\/(\w+) eq '((?:[^']|'')*)'$/);
    if (m) return String(fields[m[1]] ?? '') === m[2].replace(/''/g, "'");
    m = filter.match(/^startswith\(fields\/(\w+),'((?:[^']|'')*)'\)$/);
    if (m) return String(fields[m[1]] ?? '').startsWith(m[2].replace(/''/g, "'"));
    throw new Error('unsupported filter ' + filter);
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    state.requests.push(`${req.method} ${p}`);
    const body = await readBody(req);
    const auth = req.headers.authorization || '';
    if (p.endsWith('/oauth2/v2.0/token')) return json(res, 200, { access_token: 'fake-token', expires_in: 3600 });
    if (p.startsWith('/_dl/')) { const it = state.drive.get(p.slice(5)); return it ? (res.writeHead(200, { 'content-type': it.mime }), res.end(it.bytes)) : json(res, 404, {}); }
    if (auth !== 'Bearer fake-token') return json(res, 401, { error: { message: 'no token' } });
    let m;
    if ((m = p.match(/^\/v1\.0\/sites\/([^/]+):(\/.*)$/))) return json(res, 200, { id: state.siteId, webUrl: `https://${m[1]}${m[2]}` });
    if (p === `/v1.0/sites/${state.siteId}/lists` && req.method === 'GET') return json(res, 200, { value: [...state.lists.values()].map((l) => ({ id: l.id, displayName: l.displayName, list: l.list })) });
    if (p === `/v1.0/sites/${state.siteId}/lists` && req.method === 'POST') {
      const b = JSON.parse(body.toString()); const id = `list-${state.nextId++}`;
      state.lists.set(id, { id, displayName: b.displayName, list: b.list, columns: b.columns || [] });
      return json(res, 201, { id, displayName: b.displayName });
    }
    if ((m = p.match(/^\/v1\.0\/sites\/site-1\/lists\/([^/]+)\/drive$/))) return json(res, 200, { id: state.driveId });
    if ((m = p.match(/^\/v1\.0\/sites\/site-1\/lists\/([^/]+)\/items$/))) {
      const listId = m[1];
      if (req.method === 'GET') {
        const filter = url.searchParams.get('$filter');
        const all = [...state.items.values()].filter((it) => it.listId === listId && matchFilter(it.fields, filter));
        const skip = Number(url.searchParams.get('skip') || 0);
        const page = all.slice(skip, skip + 2); // tiny pages to exercise pagination
        const out = { value: page.map((it) => ({ id: it.id, fields: it.fields })) };
        if (skip + 2 < all.length) out['@odata.nextLink'] = `http://127.0.0.1:${server.address().port}${p}?$expand=fields&skip=${skip + 2}${filter ? `&$filter=${encodeURIComponent(filter)}` : ''}`;
        return json(res, 200, out);
      }
      if (req.method === 'POST') {
        const b = JSON.parse(body.toString()); const id = String(state.nextId++);
        state.items.set(id, { id, listId, fields: { ...b.fields } });
        return json(res, 201, { id, fields: b.fields });
      }
    }
    if ((m = p.match(/^\/v1\.0\/sites\/site-1\/lists\/([^/]+)\/items\/(\d+)(\/fields)?$/))) {
      const it = state.items.get(m[2]);
      if (!it) return json(res, 404, { error: { message: 'not found' } });
      if (req.method === 'PATCH') { Object.assign(it.fields, JSON.parse(body.toString())); return json(res, 200, it.fields); }
      if (req.method === 'DELETE') { state.items.delete(m[2]); return json(res, 204); }
    }
    if ((m = p.match(/^\/v1\.0\/drives\/drive-1\/root:\/(.+):\/content$/)) && req.method === 'PUT') {
      const path = m[1]; const id = `f${state.nextId++}`;
      state.drive.set(id, { id, path, name: path.split('/').pop(), mime: req.headers['content-type'] || '', bytes: body });
      return json(res, 201, { id, name: path.split('/').pop(), file: { mimeType: req.headers['content-type'] || '' }, size: body.length });
    }
    if ((m = p.match(/^\/v1\.0\/drives\/drive-1\/root:\/(.+):\/children$/)) && req.method === 'GET') {
      const folder = m[1] + '/';
      const kids = [...state.drive.values()].filter((f) => f.path.startsWith(folder) && !f.path.slice(folder.length).includes('/'));
      if (!kids.length) return json(res, 404, { error: { message: 'itemNotFound' } });
      return json(res, 200, { value: kids.map((f) => ({ id: f.id, name: f.name, size: f.bytes.length, file: { mimeType: f.mime } })) });
    }
    if ((m = p.match(/^\/v1\.0\/drives\/drive-1\/items\/([^/]+)\/content$/)) && req.method === 'GET') {
      res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/_dl/${m[1]}` }); return res.end();
    }
    if ((m = p.match(/^\/v1\.0\/drives\/drive-1\/root:\/(.+)$/)) && req.method === 'DELETE') {
      const folder = m[1];
      let n = 0; for (const [id, f] of state.drive) if (f.path === folder || f.path.startsWith(folder + '/')) { state.drive.delete(id); n++; }
      return n ? json(res, 204) : json(res, 404, { error: { message: 'itemNotFound' } });
    }
    json(res, 404, { error: { message: `fake graph: unhandled ${req.method} ${p}` } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, state, graphBase: `${base}/v1.0`, loginBase: base, stop: () => new Promise((r) => server.close(r)) };
}
