'use strict';
const express = require('express');

module.exports = function membersRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const includeInactive = req.query.all === '1';
    const rows = db
      .prepare(`SELECT * FROM members ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY side, name`)
      .all();
    res.json(rows);
  });

  router.post('/', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const side = b.side === 'IN' ? 'IN' : 'JP';
    if (!name) return res.status(400).json({ error: 'name_required' });
    const info = db
      .prepare('INSERT INTO members (name, name_en, side, email, role) VALUES (?, ?, ?, ?, ?)')
      .run(name, String(b.name_en || '').trim(), side, String(b.email || '').trim(), String(b.role || '').trim());
    res.status(201).json(db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid));
  });

  router.put('/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : cur.name;
    if (!name) return res.status(400).json({ error: 'name_required' });
    db.prepare(
      'UPDATE members SET name = ?, name_en = ?, side = ?, email = ?, role = ?, active = ? WHERE id = ?'
    ).run(
      name,
      b.name_en !== undefined ? String(b.name_en).trim() : cur.name_en,
      b.side === 'IN' || b.side === 'JP' ? b.side : cur.side,
      b.email !== undefined ? String(b.email).trim() : cur.email,
      b.role !== undefined ? String(b.role).trim() : cur.role,
      b.active !== undefined ? (b.active ? 1 : 0) : cur.active,
      id
    );
    res.json(db.prepare('SELECT * FROM members WHERE id = ?').get(id));
  });

  // Soft delete: keep history on past events, hide from pickers.
  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const info = db.prepare('UPDATE members SET active = 0 WHERE id = ?').run(id);
    if (!info.changes) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });

  return router;
};
