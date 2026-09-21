'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  side TEXT NOT NULL CHECK (side IN ('JP','IN')),
  email TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS event_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label_ja TEXT NOT NULL,
  label_en TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#4f6d7a',
  sort_order INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  title_en TEXT NOT NULL DEFAULT '',
  type_id INTEGER NOT NULL REFERENCES event_types(id),
  start_at TEXT NOT NULL,          -- ISO 8601 UTC
  end_at TEXT,                     -- ISO 8601 UTC (nullable)
  all_day INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo', -- timezone the event was entered in
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  owner_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','confirmed','done','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);

CREATE TABLE IF NOT EXISTS event_members (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, member_id)
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('file','link')),
  name TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  stored_name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_materials_event ON materials(event_id);
`;

const DEFAULT_TYPES = [
  ['management', '経営会議', 'Management Meeting', '#c0392b', 10],
  ['committee', 'バイオガス委員会', 'Biogas Committee', '#2874a6', 20],
  ['lecture', '講演会', 'Lecture / Seminar', '#7d3c98', 30],
  ['visitor', '来客対応', 'Visitor Reception', '#1e8449', 40],
  ['trip', '出張', 'Business Trip', '#b9770e', 50],
  ['exhibition', '展示会', 'Exhibition', '#117a65', 60],
  ['other', 'その他', 'Other', '#5d6d7e', 100],
];

function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO event_types (key, label_ja, label_en, color, sort_order) VALUES (?, ?, ?, ?, ?)'
  );
  for (const t of DEFAULT_TYPES) insert.run(...t);
  return db;
}

module.exports = { openDatabase };
