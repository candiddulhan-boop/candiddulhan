const path = require('node:path');
const fs = require('node:fs');
const multer = require('multer');
const db = require('./db');
const config = require('./config');
const { html, token, normPhone, maskId, fmtDate, fmtDuration, toCsv } = require('./util');

const STATUS_LABEL = { pending: 'Awaiting', yes: 'Attending', no: 'Declined', maybe: 'Maybe' };
const OUTCOMES = {
  connected: 'Connected', no_answer: 'No answer', busy: 'Busy', switched_off: 'Switched off',
  callback: 'Call back later', wrong_number: 'Wrong number',
};
const ID_TYPES = ['Aadhaar', 'Passport', 'Driving Licence', 'Voter ID', 'PAN', 'Other'];

const uploadDir = (kind) => path.join(config.dataDir, 'uploads', kind);

function uploader(kind, { accept }) {
  return multer({
    storage: multer.diskStorage({
      destination: uploadDir(kind),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6);
        cb(null, `${Date.now()}-${token(9)}${ext}`);
      },
    }),
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => cb(null, accept(file)),
  });
}

const idUpload = uploader('ids', {
  accept: (f) => /^image\//.test(f.mimetype) || f.mimetype === 'application/pdf',
});
const AUDIO_EXT = /\.(mp3|m4a|aac|amr|wav|ogg|opus|3gp|3gpp|mp4|awb|flac|webm)$/i;
const recordingUpload = uploader('recordings', {
  accept: (f) => /^audio\//.test(f.mimetype) || AUDIO_EXT.test(f.originalname || ''),
});

function sendUpload(res, kind, file) {
  if (!file) return res.status(404).send('Not found');
  const p = path.join(uploadDir(kind), path.basename(file));
  if (!fs.existsSync(p)) return res.status(404).send('File missing');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(p);
}

function removeUpload(kind, file) {
  if (file) fs.rm(path.join(uploadDir(kind), path.basename(file)), { force: true }, () => {});
}

const baseUrl = (req) => config.baseUrl || `${req.protocol}://${req.get('host')}`;
const inviteUrl = (req, g) => `${baseUrl(req)}/i/${g.token}`;
const clientUrl = (req, e) => `${baseUrl(req)}/c/${e.client_token}`;

const DEFAULT_INVITE =
  'Namaste {name} 🙏\n\nWith great joy we invite you to celebrate the wedding of {title}.\n\nPlease confirm your presence and share your travel details here:\n{link}\n\nWe look forward to celebrating with you!';

function inviteText(req, event, guest) {
  return (event.invite_message || DEFAULT_INVITE)
    .replaceAll('{name}', guest.name)
    .replaceAll('{title}', event.title)
    .replaceAll('{date}', event.event_date ? fmtDate(event.event_date) : '')
    .replaceAll('{venue}', event.venue || '')
    .replaceAll('{link}', inviteUrl(req, guest));
}

const waUrl = (req, event, guest) =>
  `https://wa.me/${normPhone(guest.phone)}?text=${encodeURIComponent(inviteText(req, event, guest))}`;

function stats(eventId) {
  const s = db.prepare(`SELECT
      COUNT(*) total,
      SUM(invited_at IS NOT NULL) invited,
      SUM(rsvp_status = 'yes') yes,
      SUM(rsvp_status = 'no') no,
      SUM(rsvp_status = 'maybe') maybe,
      SUM(rsvp_status = 'pending') pending,
      COALESCE(SUM(CASE WHEN rsvp_status = 'yes' THEN COALESCE(pax, 1) END), 0) pax,
      SUM(rsvp_status = 'yes' AND id_file IS NOT NULL) ids,
      SUM(rsvp_status = 'yes' AND needs_stay = 1) stay
    FROM guests WHERE event_id = ?`).get(eventId);
  for (const k of Object.keys(s)) s[k] = s[k] || 0;
  s.calls = db.prepare('SELECT COUNT(*) n FROM calls WHERE event_id = ?').get(eventId).n;
  s.recordings = db.prepare('SELECT COUNT(*) n FROM calls WHERE event_id = ? AND recording_file IS NOT NULL').get(eventId).n;
  s.sides = db.prepare(`SELECT COALESCE(NULLIF(side, ''), 'Unassigned') side, COUNT(*) guests,
      COALESCE(SUM(CASE WHEN rsvp_status = 'yes' THEN COALESCE(pax, 1) END), 0) pax
    FROM guests WHERE event_id = ? GROUP BY 1 ORDER BY 1`).all(eventId);
  s.arrivals = db.prepare(`SELECT arrival_date, COUNT(*) parties, SUM(COALESCE(pax, 1)) pax
    FROM guests WHERE event_id = ? AND rsvp_status = 'yes' AND arrival_date IS NOT NULL AND arrival_date != ''
    GROUP BY arrival_date ORDER BY arrival_date`).all(eventId);
  return s;
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function statCards(s) {
  const card = (label, value, sub) => html`<div class="stat"><div class="stat-v">${value}</div><div class="stat-l">${label}</div>${sub ? html`<div class="stat-s">${sub}</div>` : ''}</div>`;
  return html`<section class="stats">
    ${card('Guests on list', s.total, `${s.invited} invite${s.invited === 1 ? '' : 's'} sent`)}
    ${card('Responded', s.total - s.pending, `${pct(s.total - s.pending, s.total)}% response rate`)}
    ${card('Attending', s.yes, `${s.pax} people in total`)}
    ${card('Declined', s.no, s.maybe ? `${s.maybe} maybe` : '')}
    ${card('Awaiting reply', s.pending, '')}
    ${card('IDs collected', s.ids, `of ${s.yes} attending`)}
    ${card('Need stay', s.stay, '')}
    ${card('Calls logged', s.calls, `${s.recordings} recording${s.recordings === 1 ? '' : 's'}`)}
  </section>
  <div class="bar" title="Response progress">
    <span class="bar-yes" style="width:${pct(s.yes, s.total)}%"></span>
    <span class="bar-maybe" style="width:${pct(s.maybe, s.total)}%"></span>
    <span class="bar-no" style="width:${pct(s.no, s.total)}%"></span>
  </div>
  <div class="legend"><span class="dot yes"></span>Attending <span class="dot maybe"></span>Maybe <span class="dot no"></span>Declined <span class="dot pending"></span>Awaiting</div>
  <div class="grid2">
    <div class="card"><h3>By side</h3>
      <table class="mini"><tr><th>Side</th><th>Guests</th><th>Attending (people)</th></tr>
      ${s.sides.map((r) => html`<tr><td>${r.side}</td><td>${r.guests}</td><td>${r.pax}</td></tr>`)}</table>
    </div>
    <div class="card"><h3>Arrivals</h3>
      ${s.arrivals.length ? html`<table class="mini"><tr><th>Date</th><th>Parties</th><th>People</th></tr>
      ${s.arrivals.map((r) => html`<tr><td>${fmtDate(r.arrival_date)}</td><td>${r.parties}</td><td>${r.pax}</td></tr>`)}</table>`
        : html`<p class="muted">No arrival details yet.</p>`}
    </div>
  </div>`;
}

const badge = (status) => html`<span class="badge ${status}">${STATUS_LABEL[status] || status}</span>`;

// Filtered guest list for dashboards. filter: { status, side, q }
function listGuests(eventId, filter = {}) {
  const where = ['g.event_id = ?'], args = [eventId];
  if (filter.status === 'open') where.push("g.rsvp_status IN ('pending', 'maybe')");
  else if (filter.status && STATUS_LABEL[filter.status]) { where.push('g.rsvp_status = ?'); args.push(filter.status); }
  if (filter.side) { where.push('g.side = ?'); args.push(filter.side); }
  if (filter.assigned === 'none') where.push('g.assigned_to IS NULL');
  else if (filter.assigned) { where.push('g.assigned_to = ?'); args.push(Number(filter.assigned)); }
  if (filter.due) where.push("g.follow_up_at IS NOT NULL AND g.follow_up_at <= datetime('now', '+5 hours', '+30 minutes', 'start of day', '+1 day', '-5 hours', '-30 minutes')");
  if (filter.q) {
    where.push('(g.name LIKE ? OR g.phone LIKE ? OR g.group_name LIKE ?)');
    const like = `%${filter.q}%`; args.push(like, like, like);
  }
  return db.prepare(`SELECT g.*, u.name assignee,
      (SELECT COUNT(*) FROM calls c WHERE c.guest_id = g.id) call_count,
      (SELECT outcome FROM calls c WHERE c.guest_id = g.id ORDER BY called_at DESC LIMIT 1) last_outcome
    FROM guests g LEFT JOIN users u ON u.id = g.assigned_to WHERE ${where.join(' AND ')}
    ORDER BY CASE g.rsvp_status WHEN 'pending' THEN 0 WHEN 'maybe' THEN 1 WHEN 'yes' THEN 2 ELSE 3 END, g.name`).all(...args);
}

const teamMembers = () => db.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').all();

// crm: show team-only controls (owner, follow-up due). Off for the client dashboard.
function filterBar(eventId, filter, { me, crm } = {}) {
  const team = crm ? teamMembers() : [];
  const sides = db.prepare("SELECT DISTINCT side FROM guests WHERE event_id = ? AND side IS NOT NULL AND side != '' ORDER BY 1").all(eventId);
  return html`<form class="filters" method="get">
    <input type="search" name="q" value="${filter.q || ''}" placeholder="Search name, phone, group">
    <select name="status"><option value="">All statuses</option>
      <option value="open" ${filter.status === 'open' ? 'selected' : ''}>Not confirmed yet</option>
      ${Object.entries(STATUS_LABEL).map(([k, v]) => html`<option value="${k}" ${filter.status === k ? 'selected' : ''}>${v}</option>`)}
    </select>
    ${sides.length ? html`<select name="side"><option value="">Both sides</option>
      ${sides.map((r) => html`<option ${filter.side === r.side ? 'selected' : ''}>${r.side}</option>`)}</select>` : ''}
    ${team.length ? html`<select name="assigned"><option value="">Everyone’s guests</option>
      ${me ? html`<option value="${me}" ${String(filter.assigned) === String(me) ? 'selected' : ''}>My guests</option>` : ''}
      <option value="none" ${filter.assigned === 'none' ? 'selected' : ''}>Unassigned</option>
      ${team.filter((u) => u.id !== me).map((u) => html`<option value="${u.id}" ${String(filter.assigned) === String(u.id) ? 'selected' : ''}>${u.name}</option>`)}
    </select>` : ''}
    ${crm ? html`<label class="check inline-check"><input type="checkbox" name="due" value="1" ${filter.due ? 'checked' : ''}> Follow-up due</label>` : ''}
    <button>Filter</button>
  </form>`;
}

function callsTable(calls, recUrl) {
  if (!calls.length) return html`<p class="muted">No calls logged yet.</p>`;
  return html`<div class="table-wrap"><table>
    <tr><th>When</th><th>Guest</th><th>Outcome</th><th>By</th><th>Duration</th><th>Notes</th><th>Recording</th></tr>
    ${calls.map((c) => html`<tr>
      <td>${fmtDate(c.called_at)}</td>
      <td>${c.guest_name || c.phone || '—'}</td>
      <td>${OUTCOMES[c.outcome] || c.outcome || '—'}${c.direction === 'incoming' ? ' (incoming)' : ''}</td>
      <td>${c.caller || ''}</td>
      <td>${fmtDuration(c.duration_sec)}</td>
      <td class="notes">${c.notes || ''}</td>
      <td>${c.recording_file ? html`<audio controls preload="none" src="${recUrl(c)}"></audio>` : ''}</td>
    </tr>`)}
  </table></div>`;
}

const eventCalls = (eventId, limit = 200) => db.prepare(`SELECT c.*, g.name guest_name FROM calls c
  LEFT JOIN guests g ON g.id = c.guest_id WHERE c.event_id = ? ORDER BY c.called_at DESC LIMIT ?`).all(eventId, limit);

const ACTIVITY_ICON = { invite: '✉️', rsvp: '✅', id: '🪪', call: '📞', note: '📝', assign: '👤', import: '⇪', followup: '⏰' };

function logActivity(eventId, guestId, actor, kind, detail) {
  db.prepare('INSERT INTO activities (event_id, guest_id, actor, kind, detail) VALUES (?,?,?,?,?)')
    .run(eventId ?? null, guestId ?? null, actor || null, kind, detail || null);
}

function timeline(items, { showGuest } = {}) {
  if (!items.length) return html`<p class="muted">No activity yet.</p>`;
  return html`<ul class="timeline">${items.map((a) => html`<li>
    <span class="tl-icon">${ACTIVITY_ICON[a.kind] || '•'}</span>
    <div><div>${showGuest && a.guest_name ? html`<strong>${a.guest_name}</strong> · ` : ''}${a.detail || a.kind}</div>
      <small class="muted">${fmtDate(a.created_at)}${a.actor ? ` · ${a.actor}` : ''}</small></div>
  </li>`)}</ul>`;
}

const guestTimeline = (guestId) => db.prepare('SELECT * FROM activities WHERE guest_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(guestId);

// Per-team-member progress for a wedding (or all weddings when eventId is null).
function teamStats(eventId) {
  const scope = eventId ? 'AND g.event_id = ?' : '';
  const cscope = eventId ? 'AND c.event_id = ?' : '';
  const a = eventId ? [eventId] : [];
  return db.prepare(`SELECT u.id, u.name, u.role,
      (SELECT COUNT(*) FROM guests g WHERE g.assigned_to = u.id ${scope}) assigned,
      (SELECT COUNT(*) FROM guests g WHERE g.assigned_to = u.id AND g.rsvp_status IN ('pending','maybe') ${scope}) open,
      (SELECT COUNT(*) FROM guests g WHERE g.assigned_to = u.id AND g.rsvp_status = 'yes' ${scope}) confirmed,
      (SELECT COUNT(*) FROM calls c WHERE c.user_id = u.id ${cscope}) calls,
      (SELECT COUNT(*) FROM calls c WHERE c.user_id = u.id AND c.outcome = 'connected' ${cscope}) connected,
      (SELECT COUNT(*) FROM calls c WHERE c.user_id = u.id AND date(c.called_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes') ${cscope}) today,
      (SELECT COUNT(*) FROM guests g WHERE g.assigned_to = u.id AND g.follow_up_at IS NOT NULL
         AND g.follow_up_at <= datetime('now') ${scope}) overdue
    FROM users u WHERE u.active = 1 ORDER BY u.name`).all(...a, ...a, ...a, ...a, ...a, ...a, ...a);
}

function teamTable(rows) {
  if (!rows.length) return html`<p class="muted">No team members yet. <a href="/admin/team">Add your team</a> to assign guests and track calls per person.</p>`;
  return html`<div class="table-wrap"><table class="mini">
    <tr><th>Team member</th><th>Assigned</th><th>Still open</th><th>Confirmed</th><th>Calls</th><th>Connected</th><th>Today</th><th>Overdue follow-ups</th></tr>
    ${rows.map((r) => html`<tr><td><strong>${r.name}</strong></td><td>${r.assigned}</td><td>${r.open}</td><td>${r.confirmed}</td>
      <td>${r.calls}</td><td>${r.connected}${r.calls ? html` <small class="muted">(${pct(r.connected, r.calls)}%)</small>` : ''}</td>
      <td>${r.today}</td><td>${r.overdue ? html`<span class="overdue">${r.overdue}</span>` : 0}</td></tr>`)}
  </table></div>`;
}

// Stored as UTC 'YYYY-MM-DD HH:MM:SS'; <input type=datetime-local> works in IST.
const IST_MS = 330 * 60 * 1000;
const followUpToDb = (local) => {
  if (!local) return null;
  const t = Date.parse(`${local}:00Z`);
  return isNaN(t) ? null : new Date(t - IST_MS).toISOString().replace('T', ' ').slice(0, 19);
};
const followUpToInput = (utc) => (utc ? new Date(Date.parse(utc.replace(' ', 'T') + 'Z') + IST_MS).toISOString().slice(0, 16) : '');
const isOverdue = (utc) => !!utc && Date.parse(utc.replace(' ', 'T') + 'Z') <= Date.now();

function guestsCsv(eventId, { withIdNumbers }) {
  const rows = db.prepare('SELECT * FROM guests WHERE event_id = ? ORDER BY side, group_name, name').all(eventId);
  const head = ['Name', 'Phone', 'Email', 'Side', 'Group', 'Invited for', 'RSVP', 'People attending', 'Arrival date',
    'Arrival mode', 'Arrival details', 'Departure date', 'Needs stay', 'Dietary', 'Guest note', 'ID type', 'ID number',
    'ID uploaded', 'Responded at'];
  return toCsv([head, ...rows.map((g) => [g.name, g.phone, g.email, g.side, g.group_name, g.max_pax,
    STATUS_LABEL[g.rsvp_status], g.pax, g.arrival_date, g.arrival_mode, g.arrival_details, g.departure_date,
    g.needs_stay == null ? '' : g.needs_stay ? 'Yes' : 'No', g.dietary, g.guest_notes, g.id_type,
    withIdNumbers ? g.id_number : maskId(g.id_number), g.id_file ? 'Yes' : 'No', g.responded_at])]);
}

module.exports = {
  STATUS_LABEL, OUTCOMES, ID_TYPES, DEFAULT_INVITE, idUpload, recordingUpload, sendUpload, removeUpload,
  inviteUrl, clientUrl, inviteText, waUrl, stats, statCards, badge, listGuests, filterBar, callsTable, eventCalls, guestsCsv,
  teamMembers, logActivity, timeline, guestTimeline, teamStats, teamTable, followUpToDb, followUpToInput, isOverdue,
};
