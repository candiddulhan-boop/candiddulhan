// ID vault: government ID documents are encrypted at rest (AES-256-GCM), Aadhaar numbers are stored masked
// (last 4 digits only, per UIDAI guidance), document numbers are format-checked, and existing plain files are migrated.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const { token } = require('./util');

const DIR = path.join(config.dataDir, 'uploads', 'ids');
const MAGIC = Buffer.from('CDV1');

function loadKey() {
  if (process.env.ID_ENCRYPTION_KEY) return crypto.createHash('sha256').update(process.env.ID_ENCRYPTION_KEY).digest();
  const file = path.join(config.dataDir, '.id-key');
  try { return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'); } catch {}
  const k = crypto.randomBytes(32);
  fs.writeFileSync(file, k.toString('hex'), { mode: 0o600 });
  console.warn(`⚠  Generated an ID encryption key in ${file}. Back it up (or set ID_ENCRYPTION_KEY) — without it, stored IDs cannot be opened.`);
  return k;
}
const KEY = loadKey();

function encrypt(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}
function decrypt(buf) {
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('Not an encrypted ID file');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(16, 32));
  return Buffer.concat([d.update(buf.subarray(32)), d.final()]);
}

// Multer storage engine that writes only ciphertext to disk.
const storage = {
  _handleFile(_req, file, cb) {
    const chunks = [];
    file.stream.on('data', (c) => chunks.push(c));
    file.stream.on('error', cb);
    file.stream.on('end', () => {
      const filename = `${Date.now()}-${token(9)}.enc`;
      fs.writeFile(path.join(DIR, filename), encrypt(Buffer.concat(chunks)), { mode: 0o600 }, (err) => (err ? cb(err) : cb(null, { filename, size: Buffer.concat(chunks).length })));
    });
  },
  _removeFile(_req, file, cb) { fs.rm(path.join(DIR, file.filename), { force: true }, cb); },
};

function sniff(buf) {
  if (buf.subarray(0, 4).toString('hex') === '89504e47') return 'image/png';
  if (buf.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (buf.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  if (buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (/ftyp(heic|heix|mif1)/.test(buf.subarray(4, 12).toString())) return 'image/heic';
  return 'application/octet-stream';
}

function send(res, file) {
  if (!file) return res.status(404).send('Not found');
  const p = path.join(DIR, path.basename(file));
  if (!fs.existsSync(p)) return res.status(404).send('File missing');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!p.endsWith('.enc')) return res.sendFile(p); // legacy file not yet migrated
  const data = decrypt(fs.readFileSync(p));
  res.setHeader('Content-Type', sniff(data));
  res.setHeader('Content-Disposition', 'inline');
  res.send(data);
}

// Encrypt any ID files saved before encryption existed, and point the database at the new files.
function migrate() {
  let n = 0;
  for (const name of fs.existsSync(DIR) ? fs.readdirSync(DIR) : []) {
    if (name.endsWith('.enc')) continue;
    const src = path.join(DIR, name);
    const out = `${path.parse(name).name}.enc`;
    fs.writeFileSync(path.join(DIR, out), encrypt(fs.readFileSync(src)), { mode: 0o600 });
    for (const [table, col] of [['guests', 'id_file'], ['guest_members', 'id_file'], ['id_documents', 'file']]) {
      db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(out, name);
    }
    fs.rmSync(src);
    n++;
  }
  if (n) console.log(`🔐 Encrypted ${n} existing ID file${n === 1 ? '' : 's'}.`);
}

// ---- document numbers ----
const DOC_TYPES = ['Aadhaar', 'PAN', 'Passport', 'Driving Licence', 'Voter ID', 'Other'];
const clean = (v) => String(v || '').toUpperCase().replace(/[\s-]/g, '').slice(0, 30);

// Returns { value, error }. Aadhaar is reduced to its last 4 digits before it is ever stored.
function checkNumber(type, raw) {
  const v = clean(raw);
  if (!v) return { value: null };
  if (type === 'Aadhaar') {
    if (!/^\d{12}$/.test(v) && !/^X{8}\d{4}$/.test(v)) return { error: 'Aadhaar number should have 12 digits.' };
    return { value: `XXXXXXXX${v.slice(-4)}` };
  }
  if (type === 'PAN' && !/^[A-Z]{5}\d{4}[A-Z]$/.test(v)) return { error: 'PAN should look like ABCDE1234F.' };
  if (type === 'Passport' && !/^[A-Z][0-9]{7}$/.test(v)) return { error: 'Indian passport numbers look like A1234567.' };
  return { value: v };
}

// ---- extra documents (e.g. PAN in addition to the check-in ID) ----
db.exec(`CREATE TABLE IF NOT EXISTS id_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES guest_members(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  number TEXT,
  file TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS id_documents_guest ON id_documents(guest_id)');
{
  const cols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  if (!cols.includes('extra_docs')) db.exec('ALTER TABLE events ADD COLUMN extra_docs TEXT');
  if (!cols.includes('id_retention_days')) db.exec('ALTER TABLE events ADD COLUMN id_retention_days INTEGER');
}

const extraDocTypes = (e) => String(e.extra_docs || '').split(',').map((s) => s.trim()).filter((t) => DOC_TYPES.includes(t));
const docsOf = (guestId) => db.prepare('SELECT * FROM id_documents WHERE guest_id = ? ORDER BY member_id IS NOT NULL, member_id, doc_type').all(guestId);

function saveDoc(guestId, memberId, type, { number, file }) {
  const existing = db.prepare('SELECT * FROM id_documents WHERE guest_id = ? AND member_id IS ? AND doc_type = ?').get(guestId, memberId ?? null, type);
  if (existing) {
    if (file && existing.file) removeFile(existing.file);
    db.prepare('UPDATE id_documents SET number = COALESCE(?, number), file = COALESCE(?, file) WHERE id = ?').run(number ?? null, file ?? null, existing.id);
    return existing.id;
  }
  return Number(db.prepare('INSERT INTO id_documents (guest_id, member_id, doc_type, number, file) VALUES (?,?,?,?,?)')
    .run(guestId, memberId ?? null, type, number ?? null, file ?? null).lastInsertRowid);
}

// Synchronous on purpose: when someone deletes an ID, it is gone before we answer.
function removeFile(file) { if (file) fs.rmSync(path.join(DIR, path.basename(file)), { force: true }); }

// Delete every ID document of a wedding (check-in IDs, family IDs and extra documents).
function purgeEvent(eventId) {
  const files = [
    ...db.prepare('SELECT id_file f FROM guests WHERE event_id = ? AND id_file IS NOT NULL').all(eventId),
    ...db.prepare('SELECT m.id_file f FROM guest_members m JOIN guests g ON g.id = m.guest_id WHERE g.event_id = ? AND m.id_file IS NOT NULL').all(eventId),
    ...db.prepare('SELECT d.file f FROM id_documents d JOIN guests g ON g.id = d.guest_id WHERE g.event_id = ? AND d.file IS NOT NULL').all(eventId),
  ];
  files.forEach((r) => removeFile(r.f));
  db.prepare('UPDATE guests SET id_type = NULL, id_number = NULL, id_file = NULL WHERE event_id = ?').run(eventId);
  db.prepare('UPDATE guest_members SET id_type = NULL, id_number = NULL, id_file = NULL WHERE guest_id IN (SELECT id FROM guests WHERE event_id = ?)').run(eventId);
  db.prepare('DELETE FROM id_documents WHERE guest_id IN (SELECT id FROM guests WHERE event_id = ?)').run(eventId);
  return files.length;
}

migrate();
// Older records may hold full Aadhaar numbers: keep only the last 4 digits.
db.prepare("UPDATE guests SET id_number = 'XXXXXXXX' || substr(id_number, -4) WHERE id_type = 'Aadhaar' AND id_number GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'").run();
db.prepare("UPDATE guest_members SET id_number = 'XXXXXXXX' || substr(id_number, -4) WHERE id_type = 'Aadhaar' AND id_number GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'").run();

module.exports = { storage, send, encrypt, decrypt, checkNumber, DOC_TYPES, extraDocTypes, docsOf, saveDoc, removeFile, purgeEvent, migrate };
