'use strict';
const crypto = require('node:crypto');

const COOKIE = 'bgsched';

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Optional shared-passcode login. When APP_PASSCODE is empty, everything is open.
 */
function createAuth({ passcode, secret }) {
  const enabled = Boolean(passcode);
  const token = enabled ? sign('ok:' + passcode, secret) : '';

  function isAuthed(req) {
    if (!enabled) return true;
    const cookies = parseCookies(req.headers.cookie);
    const got = cookies[COOKIE] || '';
    return got.length === token.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token));
  }

  function middleware(req, res, next) {
    if (isAuthed(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
    return res.status(401).sendFile(require('node:path').join(__dirname, '..', 'public', 'login.html'));
  }

  function login(req, res) {
    const given = String((req.body && req.body.passcode) || '');
    if (!enabled) return res.json({ ok: true });
    const a = Buffer.from(given);
    const b = Buffer.from(passcode);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: 'bad_passcode' });
    }
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`
    );
    return res.json({ ok: true });
  }

  function logout(req, res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  }

  return { enabled, middleware, login, logout };
}

module.exports = { createAuth };
