// Mobile-first console for the calling team: my follow-ups, tap to call, log outcome + recording.
const express = require('express');
const db = require('../db');
const layout = require('../layout');
const { requireRole } = require('../auth');
const { html, fmtDate } = require('../util');
const S = require('../shared');
const T = require('../tenancy');

const r = express.Router();
r.use(requireRole('admin', 'caller'));

const page = (req, title, body) => layout({ title, user: req.user, body, flash: req.query.msg });

function guestCard(g, { showEvent } = {}) {
  return html`<li class="card ${S.isOverdue(g.follow_up_at) ? 'due' : ''}">
    <div><strong>${g.name}</strong> ${S.badge(g.rsvp_status)}<br>
      <small class="muted">${[showEvent && g.event_title, g.side, g.group_name, g.phone].filter(Boolean).join(' · ')}</small>
      ${g.follow_up_at ? html`<br><small class="${S.isOverdue(g.follow_up_at) ? 'overdue' : 'muted'}">⏰ Follow up ${fmtDate(g.follow_up_at)}</small>` : ''}
      ${g.call_count ? html`<br><small class="muted">${g.call_count} call${g.call_count > 1 ? 's' : ''} · last: ${S.OUTCOMES[g.last_outcome] || g.last_outcome || '—'}</small>` : ''}</div>
    <div class="call-actions">
      ${g.phone ? html`<a class="btn primary" href="tel:${g.phone}" data-call="${g.id}">📞 Call</a>` : ''}
      <a class="btn" href="/caller/guest/${g.id}">Log</a>
    </div></li>`;
}

r.get('/', (req, res) => {
  const mine = req.user.uid;
  const scope = T.eventScope(req.user);
  // Follow-ups due by the end of today (IST): mine if I have an account, otherwise everyone's.
  const due = db.prepare(`SELECT g.*, e.title event_title,
      (SELECT COUNT(*) FROM calls c WHERE c.guest_id = g.id) call_count,
      (SELECT outcome FROM calls c WHERE c.guest_id = g.id ORDER BY called_at DESC LIMIT 1) last_outcome
    FROM guests g JOIN events e ON e.id = g.event_id
    WHERE g.follow_up_at IS NOT NULL AND g.rsvp_status != 'no'
      AND g.follow_up_at <= datetime('now', '+5 hours', '+30 minutes', 'start of day', '+1 day', '-5 hours', '-30 minutes')
      AND ${scope.sql} ${mine ? 'AND g.assigned_to = ?' : ''}
    ORDER BY g.follow_up_at`).all(...scope.args, ...(mine ? [mine] : []));
  const events = db.prepare(`SELECT e.id, e.title, e.event_date, COUNT(g.id) total,
      SUM(g.rsvp_status IN ('pending','maybe')) open,
      SUM(g.rsvp_status IN ('pending','maybe') AND g.assigned_to = ?) my_open
    FROM events e LEFT JOIN guests g ON g.event_id = e.id WHERE ${scope.sql}
    GROUP BY e.id ORDER BY e.event_date IS NULL, e.event_date`).all(mine ?? -1, ...scope.args);
  const me = mine && S.teamStats(null, [{ id: mine }])[0];
  res.send(page(req, 'Caller', html`
    <h1>Hi ${req.user.name} 👋</h1>
    ${me ? html`<section class="stats small-stats">
      <div class="stat"><div class="stat-v">${me.today}</div><div class="stat-l">Calls today</div></div>
      <div class="stat"><div class="stat-v">${me.open}</div><div class="stat-l">My open guests</div></div>
      <div class="stat"><div class="stat-v">${me.confirmed}</div><div class="stat-l">Confirmed</div></div>
    </section>` : ''}
    <h2>⏰ Follow-ups due today <small class="muted">(${due.length})</small></h2>
    ${due.length ? html`<ul class="call-list">${due.map((g) => guestCard(g, { showEvent: true }))}</ul>` : html`<p class="muted">Nothing due. 🎉</p>`}
    <h2>Weddings</h2>
    <div class="cards">${events.map((e) => html`<a class="card event-card" href="/caller/${e.id}"><h2>${e.title}</h2>
      <p class="muted">${fmtDate(e.event_date)}</p>
      <p>${mine ? html`<strong>${e.my_open || 0}</strong> mine to follow up · ` : ''}${e.open || 0} open of ${e.total}</p></a>`)}</div>`));
});

r.get('/:eventId', (req, res) => {
  const e = T.loadEvent(req, res, req.params.eventId);
  if (!e) return;
  const filter = {
    status: req.query.status ?? 'open', q: req.query.q, side: req.query.side, due: req.query.due,
    assigned: req.query.assigned ?? (req.user.uid && T.eventTeam(e).length ? String(req.user.uid) : ''),
  };
  const guests = S.listGuests(e.id, filter);
  res.send(page(req, e.title, html`<h1>${e.title}</h1>
    ${S.filterBar(e.id, filter, { me: req.user.uid, crm: true })}
    <ul class="call-list">${guests.map((g) => guestCard(g))}</ul>
    ${guests.length ? '' : html`<p class="muted">No guests match. Try “All statuses” or “Everyone’s guests”.</p>`}`));
});

r.get('/guest/:id', (req, res) => {
  const { e } = T.loadGuest(req, res, req.params.id);
  if (!e) return;
  const g = db.prepare('SELECT g.*, u.name assignee FROM guests g LEFT JOIN users u ON u.id = g.assigned_to WHERE g.id = ?').get(req.params.id);
  const calls = db.prepare('SELECT c.*, ? guest_name FROM calls c WHERE guest_id = ? ORDER BY called_at DESC').all(g.name, g.id);
  res.send(page(req, g.name, html`
    <p><a href="/caller/${e.id}">← ${e.title}</a></p>
    <div class="head"><h1>${g.name} ${S.badge(g.rsvp_status)}</h1>
      <div class="actions">${g.phone ? html`<a class="btn primary" href="tel:${g.phone}">📞 ${g.phone}</a>
        <a class="btn wa" target="_blank" href="${S.waUrl(req, e, g)}">WhatsApp</a>` : ''}</div></div>
    <p class="muted">${[g.side, g.group_name, `invited for ${g.max_pax}`, g.assignee && `owner: ${g.assignee}`].filter(Boolean).join(' · ')}</p>
    ${g.internal_notes ? html`<p class="flash">${g.internal_notes}</p>` : ''}
    <form method="post" action="/caller/guest/${g.id}" enctype="multipart/form-data" class="form card">
      <h3>Log this call</h3>
      <label>Outcome<select name="outcome" required>${Object.entries(S.OUTCOMES).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
      <div class="row"><label>Update RSVP<select name="rsvp_status"><option value="">— no change —</option>
          ${Object.entries(S.STATUS_LABEL).filter(([k]) => k !== 'pending').map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
        <label>People attending<input type="number" name="pax" min="0" max="${g.max_pax}" value="${g.pax ?? ''}"></label></div>
      <div class="row"><label>Arrival date<input type="date" name="arrival_date" value="${g.arrival_date || ''}"></label>
        <label>Duration (min)<input type="number" name="duration_min" min="0" step="0.5"></label></div>
      <label>Notes<textarea name="notes" rows="3" placeholder="Coming with spouse, needs pickup from airport…"></textarea></label>
      <label>Follow up on <small>(leave empty if nothing more to do)</small>
        <input type="datetime-local" name="follow_up_at" data-followup></label>
      <div class="chips"><button type="button" data-in="2h">In 2 hours</button><button type="button" data-in="tomorrow">Tomorrow 11 am</button>
        <button type="button" data-in="2d">In 2 days</button><button type="button" data-in="">Clear</button></div>
      <label>Call recording <small>(from your phone’s recordings folder)</small><input type="file" name="recording" accept="audio/*,.amr,.m4a,.3gp,.aac"></label>
      <button class="primary big">Save call</button>
    </form>
    <div class="grid2">
      <div class="card"><h3>Timeline</h3>
        <form method="post" action="/caller/guest/${g.id}/note" class="form noteform">
          <textarea name="note" rows="2" placeholder="Add a note" required></textarea><button class="sm">Add note</button></form>
        ${S.timeline(S.guestTimeline(g.id))}</div>
      <div><h3>Calls</h3>${S.callsTable(calls, (c) => `/caller/calls/${c.id}/recording`)}</div>
    </div>`));
});

r.post('/guest/:id', S.recordingUpload.single('recording'), (req, res) => {
  const { g } = T.loadGuest(req, res, req.params.id);
  if (!g) { S.removeUpload('recordings', req.file?.filename); return; }
  const b = req.body, who = req.user.name;
  const outcome = S.OUTCOMES[b.outcome] ? b.outcome : null;
  db.prepare(`INSERT INTO calls (event_id, guest_id, phone, caller, user_id, outcome, notes, duration_sec, recording_file, source)
    VALUES (?,?,?,?,?,?,?,?,?, 'console')`).run(g.event_id, g.id, g.phone, who, req.user.uid ?? null, outcome,
    b.notes || null, b.duration_min ? Math.round(Number(b.duration_min) * 60) : null, req.file?.filename || null);
  S.logActivity(g.event_id, g.id, who, 'call', `Call: ${S.OUTCOMES[outcome] || 'logged'}${b.notes ? ` — ${b.notes}` : ''}${req.file ? ' (recording attached)' : ''}`);

  if (S.STATUS_LABEL[b.rsvp_status]) {
    db.prepare(`UPDATE guests SET rsvp_status=?, pax=COALESCE(?, pax), arrival_date=COALESCE(?, arrival_date),
      responded_at=COALESCE(responded_at, datetime('now')) WHERE id=?`)
      .run(b.rsvp_status, b.pax === '' || b.pax == null ? null : Number(b.pax), b.arrival_date || null, g.id);
    if (b.rsvp_status !== g.rsvp_status) S.logActivity(g.event_id, g.id, who, 'rsvp', `RSVP updated on call: ${S.STATUS_LABEL[b.rsvp_status]}`);
  }

  // Logging a call resolves the old follow-up; a new one is set only if the caller chose a time.
  const followUp = S.followUpToDb(b.follow_up_at);
  db.prepare('UPDATE guests SET follow_up_at = ? WHERE id = ?').run(followUp, g.id);
  if (followUp) S.logActivity(g.event_id, g.id, who, 'followup', `Follow-up set for ${fmtDate(followUp)}`);

  // Whoever calls an unassigned guest becomes their owner.
  if (!g.assigned_to && req.user.uid) {
    db.prepare('UPDATE guests SET assigned_to = ? WHERE id = ?').run(req.user.uid, g.id);
    S.logActivity(g.event_id, g.id, who, 'assign', `Assigned to ${who}`);
  }
  res.redirect(`/caller/${g.event_id}?msg=${encodeURIComponent(`Logged call with ${g.name}`)}`);
});

r.post('/guest/:id/note', (req, res) => {
  const { g } = T.loadGuest(req, res, req.params.id);
  if (!g) return;
  const note = String(req.body.note || '').trim().slice(0, 2000);
  if (note) S.logActivity(g.event_id, g.id, req.user.name, 'note', note);
  const backTo = req.body.back === `/admin/guests/${g.id}` && req.user.role === 'admin' ? req.body.back : `/caller/guest/${g.id}`;
  res.redirect(`${backTo}?msg=${encodeURIComponent(note ? 'Note added' : 'Note was empty')}`);
});

r.get('/calls/:id/recording', (req, res) => {
  const c = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (!c?.event_id || !T.canAccessEvent(req.user, T.getEvent(c.event_id))) return res.status(404).send('Not found');
  S.sendUpload(res, 'recordings', c.recording_file);
});

module.exports = r;
