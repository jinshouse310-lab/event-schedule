'use strict';
const express = require('express');

module.exports = function typesRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const includeInactive = req.query.all === '1';
    res.json(
      db.prepare(`SELECT * FROM event_types ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, id`).all()
    );
  });

  router.post('/', (req, res) => {
    const b = req.body || {};
    const label_ja = String(b.label_ja || '').trim();
    const label_en = String(b.label_en || label_ja).trim();
    if (!label_ja) return res.status(400).json({ error: 'label_required' });
    const key = String(b.key || label_en || label_ja)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `type-${Date.now()}`;
    const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#5d6d7e';
    const order = Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 90;
    try {
      const info = db
        .prepare('INSERT INTO event_types (key, label_ja, label_en, color, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run(key, label_ja, label_en, color, order);
      res.status(201).json(db.prepare('SELECT * FROM event_types WHERE id = ?').get(info.lastInsertRowid));
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'duplicate_key' });
      throw e;
    }
  });

  router.put('/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM event_types WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {};
    db.prepare(
      'UPDATE event_types SET label_ja = ?, label_en = ?, color = ?, sort_order = ?, active = ? WHERE id = ?'
    ).run(
      b.label_ja !== undefined ? String(b.label_ja).trim() || cur.label_ja : cur.label_ja,
      b.label_en !== undefined ? String(b.label_en).trim() || cur.label_en : cur.label_en,
      /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : cur.color,
      Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : cur.sort_order,
      b.active !== undefined ? (b.active ? 1 : 0) : cur.active,
      id
    );
    res.json(db.prepare('SELECT * FROM event_types WHERE id = ?').get(id));
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const info = db.prepare('UPDATE event_types SET active = 0 WHERE id = ?').run(id);
    if (!info.changes) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });

  return router;
};
