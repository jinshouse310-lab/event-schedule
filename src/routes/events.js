'use strict';
const express = require('express');

const STATUSES = new Set(['planned', 'confirmed', 'done', 'cancelled']);

function isIso(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

function toIsoUtc(s) {
  return new Date(s).toISOString();
}

module.exports = function eventsRouter(db) {
  const router = express.Router();

  const selectEvent = `
    SELECT e.*,
           t.key AS type_key, t.label_ja AS type_label_ja, t.label_en AS type_label_en, t.color AS type_color,
           m.name AS owner_name, m.name_en AS owner_name_en, m.side AS owner_side
    FROM events e
    JOIN event_types t ON t.id = e.type_id
    LEFT JOIN members m ON m.id = e.owner_id`;

  function attachDetails(ev) {
    ev.members = db
      .prepare(
        `SELECT m.id, m.name, m.name_en, m.side FROM event_members em JOIN members m ON m.id = em.member_id
         WHERE em.event_id = ? ORDER BY m.side, m.name`
      )
      .all(ev.id);
    ev.materials = db
      .prepare('SELECT * FROM materials WHERE event_id = ? ORDER BY created_at DESC, id DESC')
      .all(ev.id);
    ev.all_day = Boolean(ev.all_day);
    return ev;
  }

  function loadEvent(id) {
    const ev = db.prepare(`${selectEvent} WHERE e.id = ?`).get(id);
    return ev ? attachDetails(ev) : null;
  }

  // GET /api/events?from=ISO&to=ISO&type=ID&owner=ID&side=JP|IN&status=planned&q=text
  router.get('/', (req, res) => {
    const where = [];
    const params = [];
    const q = req.query;
    if (isIso(q.from)) { where.push('COALESCE(e.end_at, e.start_at) >= ?'); params.push(toIsoUtc(q.from)); }
    if (isIso(q.to)) { where.push('e.start_at < ?'); params.push(toIsoUtc(q.to)); }
    if (q.type) { where.push('e.type_id = ?'); params.push(Number(q.type)); }
    if (q.owner) { where.push('e.owner_id = ?'); params.push(Number(q.owner)); }
    if (q.side === 'JP' || q.side === 'IN') {
      where.push(`(m.side = ? OR EXISTS (SELECT 1 FROM event_members em JOIN members mm ON mm.id = em.member_id
                   WHERE em.event_id = e.id AND mm.side = ?))`);
      params.push(q.side, q.side);
    }
    if (q.status && STATUSES.has(q.status)) { where.push('e.status = ?'); params.push(q.status); }
    if (q.q) {
      where.push('(e.title LIKE ? OR e.title_en LIKE ? OR e.description LIKE ? OR e.location LIKE ?)');
      const like = `%${String(q.q).trim()}%`;
      params.push(like, like, like, like);
    }
    const sql = `${selectEvent} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.start_at ASC, e.id ASC LIMIT 1000`;
    const rows = db.prepare(sql).all(...params).map(attachDetails);
    res.json(rows);
  });

  router.get('/:id', (req, res) => {
    const ev = loadEvent(Number(req.params.id));
    if (!ev) return res.status(404).json({ error: 'not_found' });
    res.json(ev);
  });

  function validate(b, cur) {
    const out = {};
    out.title = b.title !== undefined ? String(b.title).trim() : cur?.title;
    if (!out.title) return { error: 'title_required' };
    out.title_en = b.title_en !== undefined ? String(b.title_en).trim() : (cur?.title_en ?? '');
    out.type_id = b.type_id !== undefined ? Number(b.type_id) : cur?.type_id;
    if (!db.prepare('SELECT 1 FROM event_types WHERE id = ?').get(out.type_id)) return { error: 'invalid_type' };
    const start = b.start_at !== undefined ? b.start_at : cur?.start_at;
    if (!isIso(start)) return { error: 'invalid_start' };
    out.start_at = toIsoUtc(start);
    const end = b.end_at !== undefined ? b.end_at : cur?.end_at;
    out.end_at = end ? (isIso(end) ? toIsoUtc(end) : null) : null;
    if (out.end_at && out.end_at < out.start_at) return { error: 'end_before_start' };
    out.all_day = b.all_day !== undefined ? (b.all_day ? 1 : 0) : (cur?.all_day ?? 0);
    out.timezone = b.timezone !== undefined ? String(b.timezone) : (cur?.timezone ?? 'Asia/Tokyo');
    try { new Intl.DateTimeFormat('en', { timeZone: out.timezone }); } catch { return { error: 'invalid_timezone' }; }
    out.location = b.location !== undefined ? String(b.location).trim() : (cur?.location ?? '');
    out.description = b.description !== undefined ? String(b.description) : (cur?.description ?? '');
    out.owner_id = b.owner_id !== undefined ? (b.owner_id ? Number(b.owner_id) : null) : (cur?.owner_id ?? null);
    if (out.owner_id && !db.prepare('SELECT 1 FROM members WHERE id = ?').get(out.owner_id)) return { error: 'invalid_owner' };
    out.status = b.status !== undefined ? String(b.status) : (cur?.status ?? 'planned');
    if (!STATUSES.has(out.status)) return { error: 'invalid_status' };
    if (b.member_ids !== undefined) {
      if (!Array.isArray(b.member_ids)) return { error: 'invalid_members' };
      out.member_ids = [...new Set(b.member_ids.map(Number).filter(Number.isInteger))];
    }
    return { value: out };
  }

  function saveMembers(eventId, memberIds) {
    db.prepare('DELETE FROM event_members WHERE event_id = ?').run(eventId);
    const ins = db.prepare('INSERT OR IGNORE INTO event_members (event_id, member_id) VALUES (?, ?)');
    for (const mid of memberIds) {
      if (db.prepare('SELECT 1 FROM members WHERE id = ?').get(mid)) ins.run(eventId, mid);
    }
  }

  router.post('/', (req, res) => {
    const { error, value: v } = validate(req.body || {}, null);
    if (error) return res.status(400).json({ error });
    let id;
    db.exec('BEGIN');
    try {
      const info = db
        .prepare(
          `INSERT INTO events (title, title_en, type_id, start_at, end_at, all_day, timezone, location, description, owner_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(v.title, v.title_en, v.type_id, v.start_at, v.end_at, v.all_day, v.timezone, v.location, v.description, v.owner_id, v.status);
      id = Number(info.lastInsertRowid);
      if (v.member_ids) saveMembers(id, v.member_ids);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.status(201).json(loadEvent(id));
  });

  router.put('/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'not_found' });
    const { error, value: v } = validate(req.body || {}, cur);
    if (error) return res.status(400).json({ error });
    db.exec('BEGIN');
    try {
      db.prepare(
        `UPDATE events SET title = ?, title_en = ?, type_id = ?, start_at = ?, end_at = ?, all_day = ?, timezone = ?,
         location = ?, description = ?, owner_id = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).run(v.title, v.title_en, v.type_id, v.start_at, v.end_at, v.all_day, v.timezone, v.location, v.description, v.owner_id, v.status, id);
      if (v.member_ids) saveMembers(id, v.member_ids);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json(loadEvent(id));
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const files = db.prepare("SELECT stored_name FROM materials WHERE event_id = ? AND kind = 'file'").all(id);
    const info = db.prepare('DELETE FROM events WHERE id = ?').run(id);
    if (!info.changes) return res.status(404).json({ error: 'not_found' });
    if (typeof router.onFilesDeleted === 'function') router.onFilesDeleted(files.map((f) => f.stored_name));
    res.json({ ok: true });
  });

  return router;
};
