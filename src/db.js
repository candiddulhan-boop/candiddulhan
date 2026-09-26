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

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- email or phone
  role TEXT NOT NULL DEFAULT 'caller',          -- admin | caller
  pass_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Timeline of everything that happened to a guest (CRM history)
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  guest_id INTEGER REFERENCES guests(id) ON DELETE CASCADE,
  actor TEXT,                     -- team member name, or 'Guest'
  kind TEXT NOT NULL,             -- invite | rsvp | id | call | note | assign | import
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS activities_guest ON activities(guest_id);
CREATE INDEX IF NOT EXISTS activities_event ON activities(event_id, created_at);
`);

// Event-management companies using the platform. The one with is_platform = 1 is Candid Dulhan itself,
// whose team can also work on partner weddings that have hired the RSVP-desk service.
db.exec(`CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  city TEXT,
  is_platform INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Additive migrations for databases created by earlier versions.
function addColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumn('guests', 'assigned_to', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
addColumn('guests', 'follow_up_at', 'TEXT');
addColumn('calls', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
addColumn('events', 'client_pin', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS guests_assigned ON guests(assigned_to, follow_up_at)');

addColumn('users', 'org_id', 'INTEGER REFERENCES orgs(id)');
addColumn('events', 'org_id', 'INTEGER REFERENCES orgs(id)');
// Candid Dulhan RSVP-desk service for this wedding: none | requested | active | declined
addColumn('events', 'service_status', "TEXT NOT NULL DEFAULT 'none'");
addColumn('events', 'service_note', 'TEXT');
addColumn('events', 'service_updated_at', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS events_org ON events(org_id, service_status)');

// Everything created before multi-company support belongs to Candid Dulhan.
db.platformOrgId = db.prepare('SELECT id FROM orgs WHERE is_platform = 1').get()?.id
  ?? Number(db.prepare("INSERT INTO orgs (name, is_platform) VALUES ('Candid Dulhan', 1)").run().lastInsertRowid);
db.prepare('UPDATE users SET org_id = ? WHERE org_id IS NULL').run(db.platformOrgId);
db.prepare('UPDATE events SET org_id = ? WHERE org_id IS NULL').run(db.platformOrgId);

module.exports = db;
