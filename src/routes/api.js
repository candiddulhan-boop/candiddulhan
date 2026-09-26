// Machine API used by the Android phone (automation app) to push call recordings.
const express = require('express');
const db = require('../db');
const { requireApiKey } = require('../auth');
const { phoneKey } = require('../util');
const S = require('../shared');

const r = express.Router();

// Prefer the guest whose wedding is upcoming/most recent when a number is on several lists.
function findGuestByPhone(phone) {
  const key = phoneKey(phone);
  if (key.length < 10) return null;
  // Recordings come from Candid Dulhan's phones: only match weddings we own or serve.
  const candidates = db.prepare(`SELECT g.*, e.event_date FROM guests g JOIN events e ON e.id = g.event_id
    WHERE g.phone IS NOT NULL AND g.phone LIKE ? AND (e.org_id = ? OR e.service_status = 'active')`).all(`%${key.slice(-4)}`, db.platformOrgId).filter((g) => phoneKey(g.phone) === key);
  const today = new Date().toISOString().slice(0, 10);
  candidates.sort((a, b) => {
    const au = (a.event_date || '9999') >= today, bu = (b.event_date || '9999') >= today;
    if (au !== bu) return au ? -1 : 1;
    return au ? (a.event_date || '9999').localeCompare(b.event_date || '9999') : (b.event_date || '').localeCompare(a.event_date || '');
  });
  return candidates[0] || null;
}

// Try to pull a phone number and timestamp out of typical Android recording filenames, e.g.
// "Call recording +91 98765 43210_240915_143012.m4a" or "919876543210-20240915143012.amr".
function parseFilename(name = '') {
  const digits = (name.match(/\+?\d[\d\s-]{8,}\d/g) || []).map((s) => s.replace(/\D/g, ''));
  const phone = digits.find((d) => d.length >= 10 && d.length <= 13) || '';
  return { phone };
}

/**
 * POST /api/recordings   (multipart/form-data, header X-API-Key)
 *   file        audio file (required)
 *   phone       other party's number (optional if present in filename)
 *   direction   incoming | outgoing
 *   duration    seconds
 *   called_at   ISO timestamp (defaults to now)
 *   caller      name of the team member / device
 */
r.post('/recordings', requireApiKey, S.recordingUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required (audio)' });
  const b = req.body;
  const phone = b.phone || parseFilename(req.file.originalname).phone;
  const guest = phone ? findGuestByPhone(phone) : null;
  const calledAt = b.called_at && !isNaN(Date.parse(b.called_at))
    ? new Date(b.called_at).toISOString().replace('T', ' ').slice(0, 19) : null;

  // If the caller already logged this call from the console (no recording yet), attach to it.
  const existing = guest && db.prepare(`SELECT id FROM calls WHERE guest_id = ? AND recording_file IS NULL
    AND abs(strftime('%s', called_at) - strftime('%s', COALESCE(?, datetime('now')))) < 1800
    ORDER BY called_at DESC LIMIT 1`).get(guest.id, calledAt);
  if (existing) {
    db.prepare('UPDATE calls SET recording_file = ?, duration_sec = COALESCE(duration_sec, ?) WHERE id = ?')
      .run(req.file.filename, b.duration ? Number(b.duration) : null, existing.id);
    S.logActivity(guest.event_id, guest.id, b.caller || 'Phone', 'call', 'Call recording synced from phone');
    return res.json({ ok: true, call_id: existing.id, matched: true, guest: guest.name, attached_to_existing: true });
  }

  const info = db.prepare(`INSERT INTO calls (event_id, guest_id, phone, direction, caller, duration_sec, recording_file, source, called_at)
    VALUES (?,?,?,?,?,?,?, 'android', COALESCE(?, datetime('now')))`)
    .run(guest?.event_id ?? null, guest?.id ?? null, phone || null, b.direction === 'incoming' ? 'incoming' : 'outgoing',
      b.caller || null, b.duration ? Number(b.duration) : null, req.file.filename, calledAt);
  if (guest) S.logActivity(guest.event_id, guest.id, b.caller || 'Phone', 'call',
    `${b.direction === 'incoming' ? 'Incoming' : 'Outgoing'} call recorded on phone${b.duration ? ` (${Math.round(b.duration / 60)} min)` : ''}`);
  res.json({ ok: true, call_id: Number(info.lastInsertRowid), matched: !!guest, guest: guest?.name ?? null });
});

// GET /api/lookup?phone=...  — lets a dialer/automation show who is calling.
r.get('/lookup', requireApiKey, (req, res) => {
  const g = findGuestByPhone(req.query.phone);
  if (!g) return res.json({ found: false });
  const e = db.prepare('SELECT title FROM events WHERE id = ?').get(g.event_id);
  res.json({ found: true, name: g.name, wedding: e.title, rsvp: g.rsvp_status, side: g.side, group: g.group_name });
});

r.use((err, _req, res, _next) => res.status(400).json({ error: err.message }));

module.exports = r;
module.exports.findGuestByPhone = findGuestByPhone;
