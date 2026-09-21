'use strict';
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');

module.exports = function materialsRouter(db, { uploadDir, maxUploadMb }) {
  const router = express.Router();

  const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 16).replace(/[^.\w-]/g, '');
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  });
  const upload = multer({ storage, limits: { fileSize: maxUploadMb * 1024 * 1024 } });

  function removeStored(storedNames) {
    for (const name of storedNames) {
      if (!name) continue;
      fs.rm(path.join(uploadDir, path.basename(name)), { force: true }, () => {});
    }
  }

  function eventExists(id) {
    return Boolean(db.prepare('SELECT 1 FROM events WHERE id = ?').get(id));
  }

  // File upload: multipart/form-data with field "file" (+ optional "name", "uploaded_by")
  router.post('/events/:id/materials/upload', (req, res, next) => {
    const eventId = Number(req.params.id);
    if (!eventExists(eventId)) return res.status(404).json({ error: 'event_not_found' });
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large', maxUploadMb });
        return next(err);
      }
      if (!req.file) return res.status(400).json({ error: 'file_required' });
      // multer decodes originalname as latin1; restore UTF-8 for Japanese file names.
      const original = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const name = String((req.body && req.body.name) || original).trim() || original;
      const info = db
        .prepare(
          `INSERT INTO materials (event_id, kind, name, stored_name, mime, size, uploaded_by)
           VALUES (?, 'file', ?, ?, ?, ?, ?)`
        )
        .run(eventId, name, req.file.filename, req.file.mimetype || '', req.file.size, String((req.body && req.body.uploaded_by) || '').trim());
      res.status(201).json(db.prepare('SELECT * FROM materials WHERE id = ?').get(info.lastInsertRowid));
    });
  });

  // External link (SharePoint, Google Drive, Box, ...)
  router.post('/events/:id/materials/link', (req, res) => {
    const eventId = Number(req.params.id);
    if (!eventExists(eventId)) return res.status(404).json({ error: 'event_not_found' });
    const b = req.body || {};
    const url = String(b.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'invalid_url' });
    const name = String(b.name || '').trim() || url;
    const info = db
      .prepare(`INSERT INTO materials (event_id, kind, name, url, uploaded_by) VALUES (?, 'link', ?, ?, ?)`)
      .run(eventId, name, url, String(b.uploaded_by || '').trim());
    res.status(201).json(db.prepare('SELECT * FROM materials WHERE id = ?').get(info.lastInsertRowid));
  });

  router.get('/materials/:id/download', (req, res) => {
    const m = db.prepare("SELECT * FROM materials WHERE id = ? AND kind = 'file'").get(Number(req.params.id));
    if (!m) return res.status(404).json({ error: 'not_found' });
    const file = path.join(uploadDir, path.basename(m.stored_name));
    if (!fs.existsSync(file)) return res.status(410).json({ error: 'file_missing' });
    const inline = req.query.inline === '1';
    res.setHeader('Content-Type', m.mime || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(m.name)}`
    );
    res.sendFile(file);
  });

  router.delete('/materials/:id', (req, res) => {
    const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(req.params.id));
    if (!m) return res.status(404).json({ error: 'not_found' });
    db.prepare('DELETE FROM materials WHERE id = ?').run(m.id);
    if (m.kind === 'file') removeStored([m.stored_name]);
    res.json({ ok: true });
  });

  router.removeStored = removeStored;
  return router;
};
