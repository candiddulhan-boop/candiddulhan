// Mobile-first console for the calling team: tap to call, then log the outcome + recording.
const express = require('express');
const db = require('../db');
const layout = require('../layout');
const { requireRole } = require('../auth');
const { html, fmtDate } = require('../util');
const S = require('../shared');

const r = express.Router();
r.use(requireRole('admin', 'caller'));

const page = (req, title, body) => layout({ title, user: req.user, body, flash: req.query.msg });

r.get('/', (req, res) => {
  const events = db.prepare(`SELECT e.id, e.title, e.event_date, SUM(g.rsvp_status IN ('pending','maybe')) todo, COUNT(g.id) total
    FROM events e LEFT JOIN guests g ON g.event_id = e.id GROUP BY e.id ORDER BY e.event_date IS NULL, e.event_date`).all();
  res.send(page(req, 'Caller', html`<h1>Choose a wedding</h1>
    <div class="cards">${events.map((e) => html`<a class="card event-card" href="/caller/${e.id}"><h2>${e.title}</h2>
      <p class="muted">${fmtDate(e.event_date)}</p><p><strong>${e.todo || 0}</strong> to follow up · ${e.total} guests</p></a>`)}</div>`));
});

r.get('/:eventId', (req, res) => {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.eventId);
  if (!e) return res.status(404).send('Not found');
  const filter = { status: req.query.status ?? 'pending', q: req.query.q, side: req.query.side };
  const guests = S.listGuests(e.id, filter);
  res.send(page(req, e.title, html`<h1>${e.title}</h1>
    ${S.filterBar(e.id, filter)}
    <ul class="call-list">${guests.map((g) => html`<li class="card">
      <div><strong>${g.name}</strong> ${S.badge(g.rsvp_status)}<br>
        <small class="muted">${[g.side, g.group_name, g.phone].filter(Boolean).join(' · ')}</small>
        ${g.call_count ? html`<br><small class="muted">${g.call_count} call${g.call_count > 1 ? 's' : ''} · last: ${S.OUTCOMES[g.last_outcome] || g.last_outcome || '—'}</small>` : ''}</div>
      <div class="call-actions">
        ${g.phone ? html`<a class="btn primary" href="tel:${g.phone}" data-call="${g.id}">📞 Call</a>` : ''}
        <a class="btn" href="/caller/guest/${g.id}">Log</a>
      </div></li>`)}</ul>
    ${guests.length ? '' : html`<p class="muted">No guests match. Try “All statuses”.</p>`}`));
});

r.get('/guest/:id', (req, res) => {
  const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).send('Not found');
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(g.event_id);
  const calls = db.prepare('SELECT c.*, ? guest_name FROM calls c WHERE guest_id = ? ORDER BY called_at DESC').all(g.name, g.id);
  res.send(page(req, g.name, html`
    <p><a href="/caller/${e.id}">← ${e.title}</a></p>
    <div class="head"><h1>${g.name} ${S.badge(g.rsvp_status)}</h1>
      <div class="actions">${g.phone ? html`<a class="btn primary" href="tel:${g.phone}">📞 ${g.phone}</a>
        <a class="btn wa" target="_blank" href="${S.waUrl(req, e, g)}">WhatsApp</a>` : ''}</div></div>
    <p class="muted">${[g.side, g.group_name, `invited for ${g.max_pax}`].filter(Boolean).join(' · ')}</p>
    <form method="post" action="/caller/guest/${g.id}" enctype="multipart/form-data" class="form card">
      <h3>Log this call</h3>
      <label>Outcome<select name="outcome" required>${Object.entries(S.OUTCOMES).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
      <div class="row"><label>Update RSVP<select name="rsvp_status"><option value="">— no change —</option>
          ${Object.entries(S.STATUS_LABEL).filter(([k]) => k !== 'pending').map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
        <label>People attending<input type="number" name="pax" min="0" max="${g.max_pax}" value="${g.pax ?? ''}"></label></div>
      <div class="row"><label>Arrival date<input type="date" name="arrival_date" value="${g.arrival_date || ''}"></label>
        <label>Duration (min)<input type="number" name="duration_min" min="0" step="0.5"></label></div>
      <label>Notes<textarea name="notes" rows="3" placeholder="Coming with spouse, needs pickup from airport…"></textarea></label>
      <label>Call recording <small>(from your phone’s recordings folder)</small><input type="file" name="recording" accept="audio/*,.amr,.m4a,.3gp,.aac"></label>
      <button class="primary big">Save call</button>
    </form>
    <h2>History</h2>${S.callsTable(calls, (c) => `/caller/calls/${c.id}/recording`)}`));
});

r.post('/guest/:id', S.recordingUpload.single('recording'), (req, res) => {
  const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(req.params.id);
  if (!g) { S.removeUpload('recordings', req.file?.filename); return res.status(404).send('Not found'); }
  const b = req.body;
  db.prepare(`INSERT INTO calls (event_id, guest_id, phone, caller, outcome, notes, duration_sec, recording_file, source)
    VALUES (?,?,?,?,?,?,?,?, 'console')`).run(g.event_id, g.id, g.phone, req.user.name, S.OUTCOMES[b.outcome] ? b.outcome : null,
    b.notes || null, b.duration_min ? Math.round(Number(b.duration_min) * 60) : null, req.file?.filename || null);
  if (S.STATUS_LABEL[b.rsvp_status]) {
    db.prepare(`UPDATE guests SET rsvp_status=?, pax=COALESCE(?, pax), arrival_date=COALESCE(?, arrival_date),
      responded_at=COALESCE(responded_at, datetime('now')) WHERE id=?`)
      .run(b.rsvp_status, b.pax === '' || b.pax == null ? null : Number(b.pax), b.arrival_date || null, g.id);
  }
  res.redirect(`/caller/${g.event_id}?msg=${encodeURIComponent(`Logged call with ${g.name}`)}`);
});

r.get('/calls/:id/recording', (req, res) =>
  S.sendUpload(res, 'recordings', db.prepare('SELECT recording_file FROM calls WHERE id = ?').get(req.params.id)?.recording_file));

module.exports = r;
