// Wedding-specific helpers: functions (Haldi, Sangeet…), per-function RSVPs, family members, sub-navigation.
const db = require('./db');
const { html, fmtDate } = require('./util');

const DEFAULT_FUNCTIONS = ['Haldi', 'Mehndi', 'Sangeet', 'Wedding', 'Reception'];
const RSVP_LABEL = { pending: 'Awaiting', yes: 'Attending', no: 'Declined', maybe: 'Maybe' };

const functionsOf = (eventId) => db.prepare('SELECT * FROM functions WHERE event_id = ? ORDER BY sort, date, time, id').all(eventId);

// Map guest_id -> Map(function_id -> {rsvp, pax}) for a wedding.
function guestFunctionMap(eventId) {
  const m = new Map();
  for (const r of db.prepare(`SELECT gf.* FROM guest_functions gf JOIN functions f ON f.id = gf.function_id WHERE f.event_id = ?`).all(eventId)) {
    if (!m.has(r.guest_id)) m.set(r.guest_id, new Map());
    m.get(r.guest_id).set(r.function_id, r);
  }
  return m;
}
const guestFunctions = (guestId) => new Map(db.prepare('SELECT * FROM guest_functions WHERE guest_id = ?').all(guestId).map((r) => [r.function_id, r]));

function inviteGuest(guestId, functionIds) {
  const ins = db.prepare('INSERT OR IGNORE INTO guest_functions (guest_id, function_id) VALUES (?,?)');
  for (const f of functionIds) ins.run(guestId, f);
}

// Overall RSVP follows the per-function answers when a guest is invited to functions.
function syncOverall(guestId) {
  const rows = db.prepare('SELECT rsvp, pax FROM guest_functions WHERE guest_id = ?').all(guestId);
  if (!rows.length) return;
  const yes = rows.filter((r) => r.rsvp === 'yes');
  const status = yes.length ? 'yes' : rows.some((r) => r.rsvp === 'maybe') ? 'maybe'
    : rows.every((r) => r.rsvp === 'no') ? 'no' : 'pending';
  const pax = yes.length ? Math.max(...yes.map((r) => r.pax || 1)) : status === 'no' ? 0 : null;
  db.prepare(`UPDATE guests SET rsvp_status = ?, pax = COALESCE(?, pax),
    responded_at = CASE WHEN ? != 'pending' THEN COALESCE(responded_at, datetime('now')) ELSE responded_at END WHERE id = ?`)
    .run(status, pax, status, guestId);
}

function setFunctionAnswer(guestId, functionId, rsvp, pax) {
  db.prepare(`UPDATE guest_functions SET rsvp = ?, pax = ? WHERE guest_id = ? AND function_id = ?`)
    .run(RSVP_LABEL[rsvp] ? rsvp : 'pending', rsvp === 'yes' ? Math.max(1, pax || 1) : rsvp === 'no' ? 0 : pax ?? null, guestId, functionId);
}

// Headcount per function.
function functionStats(eventId) {
  return db.prepare(`SELECT f.*, COUNT(gf.guest_id) invited,
      SUM(gf.rsvp = 'yes') yes, SUM(gf.rsvp = 'no') no, SUM(gf.rsvp = 'maybe') maybe, SUM(gf.rsvp = 'pending') pending,
      COALESCE(SUM(CASE WHEN gf.rsvp = 'yes' THEN COALESCE(gf.pax, 1) END), 0) people
    FROM functions f LEFT JOIN guest_functions gf ON gf.function_id = f.id WHERE f.event_id = ?
    GROUP BY f.id ORDER BY f.sort, f.date, f.time, f.id`).all(eventId);
}

function functionTable(eventId) {
  const rows = functionStats(eventId);
  if (!rows.length) return '';
  return html`<div class="card"><h3>Functions</h3><div class="table-wrap flat"><table class="mini">
    <tr><th>Function</th><th>When</th><th>Invited</th><th>Attending</th><th>People</th><th>Maybe</th><th>Declined</th><th>Awaiting</th></tr>
    ${rows.map((f) => html`<tr><td><strong>${f.name}</strong>${f.venue ? html`<br><small class="muted">${f.venue}</small>` : ''}</td>
      <td>${[fmtDate(f.date), f.time].filter(Boolean).join(' · ')}</td><td>${f.invited}</td><td>${f.yes || 0}</td>
      <td><strong>${f.people}</strong></td><td>${f.maybe || 0}</td><td>${f.no || 0}</td><td>${f.pending || 0}</td></tr>`)}
  </table></div></div>`;
}

// Compact per-function status chips for tables.
function functionChips(fns, answers) {
  if (!fns.length) return '';
  return html`<span class="chips-fn">${fns.map((f) => {
    const a = answers?.get(f.id);
    return html`<span class="fn ${a ? a.rsvp : 'none'}" title="${f.name}: ${a ? RSVP_LABEL[a.rsvp] : 'Not invited'}">${f.name.slice(0, 2)}</span>`;
  })}</span>`;
}

const membersOf = (guestId) => db.prepare('SELECT * FROM guest_members WHERE guest_id = ? ORDER BY sort, id').all(guestId);

// Sub-navigation shown on every wedding page for the team.
function eventNav(e, active, { owner } = {}) {
  const tab = (key, label, href) => html`<a class="${active === key ? 'on' : ''}" href="${href}">${label}</a>`;
  return html`<nav class="tabs subnav">
    ${tab('guests', 'Guests', `/admin/events/${e.id}`)}
    ${tab('functions', 'Functions', `/admin/events/${e.id}/functions`)}
    ${tab('rooming', 'Rooming', `/admin/events/${e.id}/rooming`)}
    ${tab('transport', 'Transport', `/admin/events/${e.id}/transport`)}
    ${tab('fields', 'Custom fields', `/admin/events/${e.id}/fields`)}
    ${tab('whatsapp', '💬 WhatsApp', `/admin/events/${e.id}/whatsapp`)}
    ${tab('automation', '⚙️ Automation', `/admin/events/${e.id}/automation`)}
    ${tab('insights', '✨ Reports & AI', `/admin/events/${e.id}/insights`)}
    ${owner ? tab('settings', 'Settings', `/admin/events/${e.id}/settings`) : ''}
  </nav>`;
}

module.exports = { DEFAULT_FUNCTIONS, RSVP_LABEL, functionsOf, guestFunctionMap, guestFunctions, inviteGuest, syncOverall, setFunctionAnswer,
  functionStats, functionTable, functionChips, membersOf, eventNav };
