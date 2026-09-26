const express = require('express');
const db = require('../db');
const layout = require('../layout');
const { html, maskId, fmtDate } = require('../util');
const S = require('../shared');

const r = express.Router();

const load = (tokenParam) => {
  const g = db.prepare('SELECT * FROM guests WHERE token = ?').get(tokenParam);
  return g ? { g, e: db.prepare('SELECT e.*, o.name org_name, o.is_platform FROM events e JOIN orgs o ON o.id = e.org_id WHERE e.id = ?').get(g.event_id) } : null;
};

const notFound = (res) => res.status(404).send(layout({ title: 'Invitation not found', nav: false,
  body: html`<div class="card center"><h1>Invitation not found</h1><p>Please check the link you received, or contact the family.</p></div>` }));

function form(e, g, error) {
  const v = (k) => g[k] ?? '';
  const radio = (name, val, label, cur) => html`<label class="pill"><input type="radio" name="${name}" value="${val}" ${String(cur) === String(val) ? 'checked' : ''} required><span>${label}</span></label>`;
  return html`
  <div class="invite">
    <p class="eyebrow">You are invited to the wedding of</p>
    <h1 class="couple">${e.title}</h1>
    <p class="when">${[fmtDate(e.event_date), e.venue, e.city].filter(Boolean).join(' · ')}</p>
    ${e.welcome_note ? html`<p class="note">${e.welcome_note}</p>` : ''}
  </div>
  ${error ? html`<div class="flash warn">${error}</div>` : ''}
  <form method="post" enctype="multipart/form-data" class="form card rsvp" data-rsvp>
    <p>Dear <strong>${g.name}</strong>, will you be joining us?</p>
    <div class="pills">
      ${radio('rsvp_status', 'yes', 'Joyfully accept', g.rsvp_status)}
      ${radio('rsvp_status', 'maybe', 'Not sure yet', g.rsvp_status)}
      ${radio('rsvp_status', 'no', 'Regretfully decline', g.rsvp_status)}
    </div>
    <div data-when="yes maybe">
      <label>Number of people attending${g.max_pax > 1 ? html` <small>(up to ${g.max_pax})</small>` : ''}
        <input type="number" name="pax" min="1" max="${g.max_pax}" value="${v('pax') || g.max_pax}"></label>
      ${e.collect_travel ? html`
        <fieldset><legend>Travel</legend>
          <div class="row"><label>Arrival date<input type="date" name="arrival_date" value="${v('arrival_date')}"></label>
            <label>Arriving by<select name="arrival_mode">${['', 'Flight', 'Train', 'Car', 'Bus', 'Local'].map((m) => html`<option ${g.arrival_mode === m ? 'selected' : ''}>${m}</option>`)}</select></label></div>
          <label>Flight / train number &amp; time<input name="arrival_details" value="${v('arrival_details')}" placeholder="e.g. 6E 2134, lands 2:30 pm"></label>
          <div class="row"><label>Departure date<input type="date" name="departure_date" value="${v('departure_date')}"></label>
            <label>Need accommodation?<select name="needs_stay"><option value=""></option>
              <option value="1" ${g.needs_stay === 1 ? 'selected' : ''}>Yes</option><option value="0" ${g.needs_stay === 0 ? 'selected' : ''}>No</option></select></label></div>
        </fieldset>` : ''}
      <label>Dietary preference<select name="dietary">${['', 'Vegetarian', 'Non-vegetarian', 'Jain', 'Vegan', 'Other'].map((d) => html`<option ${g.dietary === d ? 'selected' : ''}>${d}</option>`)}</select></label>
      ${e.require_id ? html`
        <fieldset><legend>Government ID</legend>
          <p class="muted small">Required by the hotel/venue for check-in and security. Shared only with the wedding family and their planners, and deleted after the event.</p>
          ${g.id_file ? html`<p class="ok">✓ ${g.id_type} received ${g.id_number ? html`(${maskId(g.id_number)})` : ''}. Upload again only to replace it.</p>` : ''}
          <div class="row"><label>ID type<select name="id_type">${['', ...S.ID_TYPES].map((t) => html`<option ${g.id_type === t ? 'selected' : ''}>${t}</option>`)}</select></label>
            <label>ID number<input name="id_number" autocomplete="off" placeholder="${g.id_number ? maskId(g.id_number) : ''}"></label></div>
          <label>Photo of ID (front)<input type="file" name="id_file" accept="image/*,application/pdf"></label>
          <label class="check"><input type="checkbox" name="id_consent" value="1" ${g.id_consent_at ? 'checked' : ''}> I consent to sharing this ID with the hosts and their planners for this wedding.</label>
        </fieldset>` : ''}
    </div>
    <label>Message for the couple <small>(optional)</small><textarea name="guest_notes" rows="2">${v('guest_notes')}</textarea></label>
    <button class="primary big">${g.responded_at ? 'Update my RSVP' : 'Send RSVP'}</button>
  </form>`;
}

r.get('/:token', (req, res) => {
  const d = load(req.params.token);
  if (!d) return notFound(res);
  const { e, g } = d;
  if (req.query.done) {
    const msg = { yes: 'We can’t wait to celebrate with you!', maybe: 'Thank you — please update us once your plans are confirmed.', no: 'Thank you for letting us know. You will be missed!' }[g.rsvp_status];
    return res.send(layout({ title: e.title, nav: false, event: e, body: html`
      <div class="invite"><p class="eyebrow">${e.title}</p><h1 class="couple">Thank you, ${g.name}</h1><p class="note">${msg}</p>
      ${g.rsvp_status !== 'no' && e.require_id && !g.id_file ? html`<p class="flash warn">Please remember to upload your ID so we can arrange your check-in.</p>` : ''}
      <p><a class="btn" href="/i/${g.token}">Edit my response</a></p></div>` }));
  }
  res.send(layout({ title: e.title, nav: false, event: e, body: form(e, g) }));
});

r.post('/:token', S.idUpload.single('id_file'), (req, res) => {
  const d = load(req.params.token);
  if (!d) { S.removeUpload('ids', req.file?.filename); return notFound(res); }
  const { e, g } = d;
  const b = req.body;
  const status = ['yes', 'no', 'maybe'].includes(b.rsvp_status) ? b.rsvp_status : null;
  const fail = (msg) => { S.removeUpload('ids', req.file?.filename); res.status(400).send(layout({ title: e.title, nav: false, event: e, body: form(e, { ...g, ...b }, msg) })); };
  if (!status) return fail('Please choose whether you will attend.');
  if (req.file && !b.id_consent) return fail('Please tick the consent box to share your ID.');

  const going = status !== 'no';
  const pax = going ? Math.min(g.max_pax, Math.max(1, parseInt(b.pax, 10) || 1)) : 0;
  const opt = (k) => (going && b[k] ? String(b[k]).slice(0, 200) : null);
  db.prepare(`UPDATE guests SET rsvp_status=?, pax=?, arrival_date=?, arrival_mode=?, arrival_details=?, departure_date=?,
    needs_stay=?, dietary=?, guest_notes=?, responded_at=datetime('now') WHERE id=?`)
    .run(status, pax, opt('arrival_date'), opt('arrival_mode'), opt('arrival_details'), opt('departure_date'),
      going && b.needs_stay !== '' && b.needs_stay != null ? Number(b.needs_stay) : null, opt('dietary'),
      b.guest_notes ? String(b.guest_notes).slice(0, 1000) : null, g.id);
  S.logActivity(e.id, g.id, 'Guest', 'rsvp', `${g.responded_at ? 'Updated RSVP' : 'RSVP received'}: ${S.STATUS_LABEL[status]}${going ? ` (${pax} ${pax === 1 ? 'person' : 'people'})` : ''}`);

  if (going && e.require_id && (req.file || b.id_type || b.id_number)) {
    if (req.file) S.removeUpload('ids', g.id_file);
    db.prepare(`UPDATE guests SET id_type=COALESCE(?, id_type), id_number=COALESCE(?, id_number), id_file=COALESCE(?, id_file),
      id_consent_at=CASE WHEN ? THEN datetime('now') ELSE id_consent_at END WHERE id=?`)
      .run(b.id_type || null, b.id_number ? String(b.id_number).replace(/\s+/g, '').slice(0, 30) : null,
        req.file?.filename || null, b.id_consent ? 1 : 0, g.id);
    if (req.file) S.logActivity(e.id, g.id, 'Guest', 'id', `ID uploaded${b.id_type ? ` (${b.id_type})` : ''}`);
  } else S.removeUpload('ids', req.file?.filename);

  res.redirect(`/i/${g.token}?done=1`);
});

module.exports = r;
