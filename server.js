'use strict';
const path = require('node:path');
const express = require('express');
const { openDatabase } = require('./src/db');
const { createAuth } = require('./src/auth');

function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'));
  const maxUploadMb = Number(options.maxUploadMb || process.env.MAX_UPLOAD_MB || 50);
  const passcode = options.passcode !== undefined ? options.passcode : process.env.APP_PASSCODE || '';
  const secret = options.secret || process.env.SESSION_SECRET || 'change-me';

  const db = openDatabase(dataDir);
  const uploadDir = path.join(dataDir, 'uploads');
  const auth = createAuth({ passcode, secret });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Login endpoints are always reachable.
  app.post('/api/login', auth.login);
  app.post('/api/logout', auth.logout);
  app.get('/api/auth', (req, res) => res.json({ required: auth.enabled }));
  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
  app.use('/static', express.static(path.join(__dirname, 'public'), { index: false }));

  app.use(auth.middleware);

  const materials = require('./src/routes/materials')(db, { uploadDir, maxUploadMb });
  const events = require('./src/routes/events')(db);
  events.onFilesDeleted = materials.removeStored;

  app.use('/api/members', require('./src/routes/members')(db));
  app.use('/api/types', require('./src/routes/types')(db));
  app.use('/api/events', events);
  app.use('/api', materials);
  app.use('/', require('./src/routes/ics')(db));
  app.get('/api/config', (req, res) => res.json({ maxUploadMb, authRequired: auth.enabled }));

  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    res.status(500).json({ error: 'internal_error' });
  });

  app.locals.db = db;
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.listen(port, () => {
    console.log(`Biogas event schedule listening on http://localhost:${port}`);
    if (!process.env.APP_PASSCODE) console.log('APP_PASSCODE is not set: login is disabled.');
  });
}

module.exports = { createApp };
