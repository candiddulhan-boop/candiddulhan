const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'uploads', 'ids'), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'uploads', 'recordings'), { recursive: true });

const db = new DatabaseSync(path.join(config.dataDir, 'rsvp.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,            -- e.g. "Aarav & Diya"
  client_name TEXT,               -- who hired us
  client_phone TEXT,
  event_date TEXT,
  venue TEXT,
  city TEXT,
  invite_message TEXT,            -- WhatsApp template with {name} {link} {title}
  welcome_note TEXT,              -- shown on the RSVP page
  require_id INTEGER NOT NULL DEFAULT 1,
  collect_travel INTEGER NOT NULL DEFAULT 1,
  client_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  side TEXT,                      -- Bride / Groom
  group_name TEXT,                -- family / friends / office ...
  max_pax INTEGER NOT NULL DEFAULT 1,
  token TEXT NOT NULL UNIQUE,
  invited_at TEXT,
  rsvp_status TEXT NOT NULL DEFAULT 'pending',   -- pending | yes | no | maybe
  pax INTEGER,
  arrival_date TEXT,
  arrival_mode TEXT,
  arrival_details TEXT,           -- flight/train no, time
  departure_date TEXT,
  needs_stay INTEGER,
  dietary TEXT,
  guest_notes TEXT,
  responded_at TEXT,
  id_type TEXT,
  id_number TEXT,
  id_file TEXT,
  id_consent_at TEXT,
  internal_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS guests_event ON guests(event_id);
CREATE INDEX IF NOT EXISTS guests_phone ON guests(phone);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
  phone TEXT,
  direction TEXT NOT NULL DEFAULT 'outgoing',
  caller TEXT,
  outcome TEXT,                   -- connected | no_answer | busy | wrong_number | callback | switched_off
  notes TEXT,
  duration_sec INTEGER,
  recording_file TEXT,
  source TEXT NOT NULL DEFAULT 'console',        -- console | android
  called_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS calls_event ON calls(event_id);
CREATE INDEX IF NOT EXISTS calls_guest ON calls(guest_id);
`);

module.exports = db;
