// Local / self-hosted server: serves public/ and runs the same handler as the
// Netlify Function against a file-backed Blobs server (data/blobs).
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BlobsServer } from '@netlify/blobs/server';
import { setEnvironmentContext } from '@netlify/blobs';
import { createHandler } from './src/app.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

export async function startLocalBlobs(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const token = 'local-dev-token';
  const blobs = new BlobsServer({ directory, token });
  const { port } = await blobs.start();
  const edgeURL = `http://127.0.0.1:${port}`;
  setEnvironmentContext({ edgeURL, uncachedEdgeURL: edgeURL, siteID: 'local-site', token });
  return blobs;
}

async function toRequest(req) {
  const url = `http://${req.headers.host || 'localhost'}${req.url}`;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : null;
  return new Request(url, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? null : body });
}
async function send(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = k === 'set-cookie' ? response.headers.getSetCookie() : v; });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}
function serveStatic(res, file) {
  const abs = path.join(PUBLIC_DIR, path.normalize(file));
  if (!abs.startsWith(PUBLIC_DIR) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}

async function main() {
  await startLocalBlobs(path.join(DATA_DIR, 'blobs'));
  const handler = createHandler({ passcode: process.env.APP_PASSCODE || '', secret: process.env.SESSION_SECRET || '', maxUploadMb: process.env.MAX_UPLOAD_MB || 50 });
  http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    try {
      if (pathname.startsWith('/api/') || pathname === '/calendar.ics') return await send(res, await handler(await toRequest(req)));
      if (pathname === '/' || pathname === '/index.html') return serveStatic(res, 'index.html');
      if (pathname === '/login') return serveStatic(res, 'login.html');
      return serveStatic(res, pathname);
    } catch (e) {
      console.error(e);
      res.writeHead(500); res.end('Internal error');
    }
  }).listen(PORT, () => {
    console.log(`Biogas event schedule listening on http://localhost:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
    if (!process.env.APP_PASSCODE) console.log('WARNING: APP_PASSCODE is not set. The app will refuse access until it is set.');
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
