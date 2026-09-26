// Guest-facing invitation + RSVP: per-function answers, family members with IDs, travel, stay and custom questions.
const express = require('express');
const db = require('../db');
const layout = require('../layout');
const { html, maskId, fmtDate } = require('../util');
const S = require('../shared');
const W = require('../wedding');
const F = require('../fields');

const r = express.Router();

const load = (tokenParam) => {
  const g = db.prepare('SELECT * FROM guests WHERE token = ?').get(tokenParam);
  return g ? { g, e: db.prepare('SELECT e.*, o.name org_name, o.is_platform FROM events e JOIN orgs o ON o.id = e.org_id WHERE e.id = ?').get(g.event_id) } : null;
};

const notFound = (res) => res.status(404).send(layout({ title: 'Invitation not found', nav: false,
  body: html`<div class="card center"><h1>Invitation not found</h1><p>Please check the link you received, or contact the family.</p></div>` }));

// Fields a guest may fill in about their own travel and needs.
const GUEST_KEYS = ['kids', 'arrival_date', 'arrival_time', 'arrival_mode', 'arrival_details', 'arrival_from', 'arrival_point', 'pickup_required',
  'departure_date', 'departure_time', 'departure_mode', 'departure_number', 'departure_point', 'drop_required', 'needs_stay',
  'dietary', 'allergies', 'special_needs'];
const TRAVEL_KEYS = GUEST_KEYS.filter((k) => /^(arrival|departure|pickup|drop|needs_stay)/.test(k));

// Invited functions for this guest, in order.
const invitedFunctions = (e, g) => {
  const answers = W.guestFunctions(g.id);
  return W.functionsOf(e.id).filter((f) => answers.has(f.id)).map((f) => ({ ...f, answer: answers.get(f.id) }));
};

function form(e, g, { error, posted } = {}) {
  const v = (k) => (posted ? posted[k] : g[k]) ?? '';
  const fns = invitedFunctions(e, g);
  const members = W.membersOf(g.id);
  const cfs = F.customFields(e.id).filter((cf) => cf.on_rsvp);
  const cvals = F.customValues(g.id);
  const field = (k, extra = {}) => html`<label>${extra.label || F.FIELD[k].label}${F.input(F.FIELD[k], v(k))}</label>`;
  const radios = (name, cur, short) => html`<div class="pills ${short ? 'compact' : ''}">${(short
    ? [['yes', 'Attending'], ['maybe', 'Maybe'], ['no', 'Can’t make it']]
    : [['yes', 'Joyfully accept'], ['maybe', 'Not sure yet'], ['no', 'Regretfully decline']])
    .map(([val, label]) => html`<label class="pill"><input type="radio" name="${name}" value="${val}" data-answer ${cur === val ? 'checked' : ''} required><span>${label}</span></label>`)}</div>`;
  const memberSlots = Math.max(0, g.max_pax - 1);
  const idTypes = ['', ...S.ID_TYPES];
  return html`
  <div class="invite">
    <p class="eyebrow">You are invited to the wedding of</p>
    <h1 class="couple">${e.title}</h1>
    <p class="when">${[fmtDate(e.event_date), e.venue, e.city].filter(Boolean).join(' · ')}</p>
    ${e.welcome_note ? html`<p class="note">${e.welcome_note}</p>` : ''}
  </div>
  ${error ? html`<div class="flash warn">${error}</div>` : ''}
  <form method="post" enctype="multipart/form-data" class="form card rsvp" data-rsvp>
    <p>Dear <strong>${[g.salutation, g.name].filter(Boolean).join(' ')}</strong>${g.max_pax > 1 ? html` (invited for ${g.max_pax})` : ''}, will you be joining us?</p>
    ${fns.length ? fns.map((f) => html`<div class="fn-block">
        <div class="fn-head"><strong>${f.name}</strong>
          <span class="muted small">${[fmtDate(f.date), f.time, f.venue].filter(Boolean).join(' · ')}${f.dress_code ? ` · Dress code: ${f.dress_code}` : ''}</span></div>
        ${radios(`fn_${f.id}`, posted ? posted[`fn_${f.id}`] : f.answer.rsvp, true)}
        ${g.max_pax > 1 ? html`<label class="inline-label" data-show-if="fn_${f.id}">People attending
          <input type="number" name="fn_pax_${f.id}" min="1" max="${g.max_pax}" value="${(posted ? posted[`fn_pax_${f.id}`] : f.answer.pax) || g.max_pax}"></label>` : ''}
      </div>`)
    : html`${radios('rsvp_status', posted ? posted.rsvp_status : g.rsvp_status)}
      ${g.max_pax > 1 ? html`<label data-when="yes maybe">Number of people attending <small>(up to ${g.max_pax})</small>
        <input type="number" name="pax" min="1" max="${g.max_pax}" value="${v('pax') || g.max_pax}"></label>` : ''}`}

    <div data-when="yes maybe">
      ${memberSlots ? html`<fieldset><legend>Who is coming with you?</legend>
        <p class="muted small">Names help us prepare rooms, meals and welcome kits.${e.require_id ? ' Hotels need an ID for every adult.' : ''}</p>
        ${Array.from({ length: memberSlots }, (_, i) => {
          const m = members[i] || {};
          const pv = (k) => (posted ? posted[`m_${i}_${k}`] : undefined);
          return html`<div class="member-slot">
            <input type="hidden" name="m_${i}_id" value="${m.id || ''}">
            <div class="fields">
              <label>Name<input name="m_${i}_name" value="${pv('name') ?? m.name ?? ''}"></label>
              <label>Relation<input name="m_${i}_relation" value="${pv('relation') ?? m.relation ?? ''}" placeholder="Wife, son…"></label>
              <label>Age group<select name="m_${i}_age">${['', 'Adult', 'Child', 'Senior'].map((a) => html`<option ${(pv('age') ?? m.age_group) === a ? 'selected' : ''}>${a}</option>`)}</select></label>
              ${e.require_id ? html`
                <label>ID type<select name="m_${i}_idtype">${idTypes.map((t) => html`<option ${(pv('idtype') ?? m.id_type) === t ? 'selected' : ''}>${t}</option>`)}</select></label>
                <label>ID number<input name="m_${i}_idnum" autocomplete="off" placeholder="${m.id_number ? maskId(m.id_number) : ''}"></label>
                <label>ID photo ${m.id_file ? html`<small class="ok">✓ received</small>` : ''}<input type="file" name="m_${i}_file" accept="image/*,application/pdf"></label>` : ''}
            </div></div>`;
        })}
        <label>Children in your party<input type="number" name="kids" min="0" max="${g.max_pax}" value="${v('kids')}"></label>
      </fieldset>` : ''}

      ${e.collect_travel ? html`
        <fieldset><legend>Arrival</legend><div class="fields">
          ${field('arrival_date')}${field('arrival_time')}${field('arrival_mode')}${field('arrival_details')}
          ${field('arrival_from')}${field('arrival_point')}${field('pickup_required', { label: 'Need a pickup?' })}
        </div></fieldset>
        <fieldset><legend>Departure</legend><div class="fields">
          ${field('departure_date')}${field('departure_time')}${field('departure_mode')}${field('departure_number')}
          ${field('departure_point')}${field('drop_required', { label: 'Need a drop?' })}
        </div></fieldset>
        <fieldset><legend>Stay</legend><div class="fields">${field('needs_stay', { label: 'Need accommodation?' })}</div></fieldset>` : ''}

      <fieldset><legend>Food &amp; care</legend><div class="fields">
        ${field('dietary')}${field('allergies')}${field('special_needs', { label: 'Anything we should arrange?' })}
      </div></fieldset>

      ${cfs.length ? html`<fieldset><legend>A few more details</legend><div class="fields">
        ${cfs.map((cf) => html`<label>${cf.label}${F.customInput(cf, posted ? posted[`cf_${cf.id}`] : cvals.get(cf.id))}</label>`)}
      </div></fieldset>` : ''}

      ${e.require_id ? html`
        <fieldset><legend>Your government ID</legend>
          <p class="muted small">Required by the hotel/venue for check-in and security. Shared only with the wedding family and their planners, and deleted after the event.</p>
          ${g.id_file ? html`<p class="ok">✓ ${g.id_type} received ${g.id_number ? html`(${maskId(g.id_number)})` : ''}. Upload again only to replace it.</p>` : ''}
          <div class="fields"><label>ID type<select name="id_type">${idTypes.map((t) => html`<option ${(v('id_type')) === t ? 'selected' : ''}>${t}</option>`)}</select></label>
            <label>ID number<input name="id_number" autocomplete="off" placeholder="${g.id_number ? maskId(g.id_number) : ''}"></label>
            <label>Photo of ID (front)<input type="file" name="id_file" accept="image/*,application/pdf"></label></div>
          <label class="check"><input type="checkbox" name="id_consent" value="1" ${g.id_consent_at || (posted && posted.id_consent) ? 'checked' : ''}> I consent to sharing these IDs (mine and my family’s) with the hosts and their planners for this wedding.</label>
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
    const fns = invitedFunctions(e, g);
    const msg = { yes: 'We can’t wait to celebrate with you!', maybe: 'Thank you — please update us once your plans are confirmed.', no: 'Thank you for letting us know. You will be missed!', pending: 'Thank you!' }[g.rsvp_status];
    return res.send(layout({ title: e.title, nav: false, event: e, body: html`
      <div class="invite"><p class="eyebrow">${e.title}</p><h1 class="couple">Thank you, ${g.name}</h1><p class="note">${msg}</p>
      ${fns.length ? html`<div class="card summary">${fns.map((f) => html`<p><strong>${f.name}</strong>
        <span class="muted">${[fmtDate(f.date), f.time].filter(Boolean).join(' · ')}</span> — ${S.badge(f.answer.rsvp)}${f.answer.rsvp === 'yes' && g.max_pax > 1 ? ` · ${f.answer.pax} people` : ''}</p>`)}</div>` : ''}
      ${g.rsvp_status !== 'no' && e.require_id && !g.id_file ? html`<p class="flash warn">Please remember to upload your ID so we can arrange your check-in.</p>` : ''}
      <p><a class="btn" href="/i/${g.token}">Edit my response</a></p></div>` }));
  }
  res.send(layout({ title: e.title, nav: false, event: e, body: form(e, g) }));
});

r.post('/:token', S.idUploadMany.any(), (req, res) => {
  const files = new Map((req.files || []).map((f) => [f.fieldname, f.filename]));
  const dropFiles = () => files.forEach((f) => S.removeUpload('ids', f));
  const d = load(req.params.token);
  if (!d) { dropFiles(); return notFound(res); }
  const { e, g } = d;
  const b = req.body;
  const fail = (msg) => { dropFiles(); res.status(400).send(layout({ title: e.title, nav: false, event: e, body: form(e, g, { error: msg, posted: b }) })); };

  const fns = invitedFunctions(e, g);
  const answer = (x) => (['yes', 'no', 'maybe'].includes(x) ? x : null);
  let going;
  if (fns.length) {
    if (fns.some((f) => !answer(b[`fn_${f.id}`]))) return fail('Please answer for each function.');
    going = fns.some((f) => b[`fn_${f.id}`] !== 'no');
  } else {
    if (!answer(b.rsvp_status)) return fail('Please choose whether you will attend.');
    going = b.rsvp_status !== 'no';
  }
  if (files.size && !b.id_consent) return fail('Please tick the consent box to share IDs.');

  // Answers
  const summary = [];
  if (fns.length) {
    for (const f of fns) {
      const a = b[`fn_${f.id}`];
      const pax = a === 'yes' ? Math.min(g.max_pax, Math.max(1, parseInt(b[`fn_pax_${f.id}`], 10) || 1)) : null;
      W.setFunctionAnswer(g.id, f.id, a, pax);
      summary.push(`${f.name}: ${W.RSVP_LABEL[a]}${pax && g.max_pax > 1 ? ` (${pax})` : ''}`);
    }
    W.syncOverall(g.id);
  } else {
    const pax = going ? Math.min(g.max_pax, Math.max(1, parseInt(b.pax, 10) || 1)) : 0;
    db.prepare(`UPDATE guests SET rsvp_status = ?, pax = ?, responded_at = datetime('now') WHERE id = ?`).run(b.rsvp_status, pax, g.id);
    summary.push(`${S.STATUS_LABEL[b.rsvp_status]}${going ? ` (${pax} ${pax === 1 ? 'person' : 'people'})` : ''}`);
  }
  db.prepare("UPDATE guests SET guest_notes = ?, responded_at = COALESCE(responded_at, datetime('now')) WHERE id = ?")
    .run(b.guest_notes ? String(b.guest_notes).slice(0, 1000) : null, g.id);

  if (going) {
    const keys = e.collect_travel ? GUEST_KEYS : GUEST_KEYS.filter((k) => !TRAVEL_KEYS.includes(k));
    F.update(g.id, F.parse(b, keys));
    F.saveCustom(g.id, F.customFields(e.id).filter((cf) => cf.on_rsvp), b);

    // Family members: update the slots the guest filled in, remove ones they cleared.
    const mine = new Map(W.membersOf(g.id).map((m) => [m.id, m]));
    for (let i = 0; i < Math.max(0, g.max_pax - 1); i++) {
      const id = Number(b[`m_${i}_id`]) || null;
      const existing = id && mine.get(id);
      const name = String(b[`m_${i}_name`] || '').trim().slice(0, 80);
      const file = files.get(`m_${i}_file`);
      if (!name) {
        if (existing) { S.removeUpload('ids', existing.id_file); db.prepare('DELETE FROM guest_members WHERE id = ?').run(existing.id); }
        if (file) { S.removeUpload('ids', file); files.delete(`m_${i}_file`); }
        continue;
      }
      const vals = [name, String(b[`m_${i}_relation`] || '').slice(0, 60) || null,
        ['Adult', 'Child', 'Senior'].includes(b[`m_${i}_age`]) ? b[`m_${i}_age`] : null,
        e.require_id ? b[`m_${i}_idtype`] || null : null,
        e.require_id && b[`m_${i}_idnum`] ? String(b[`m_${i}_idnum`]).replace(/\s+/g, '').slice(0, 30) : null, file || null];
      if (existing) {
        if (file) S.removeUpload('ids', existing.id_file);
        db.prepare(`UPDATE guest_members SET name = ?, relation = ?, age_group = ?, id_type = COALESCE(?, id_type),
          id_number = COALESCE(?, id_number), id_file = COALESCE(?, id_file) WHERE id = ?`).run(...vals, existing.id);
      } else {
        db.prepare('INSERT INTO guest_members (name, relation, age_group, id_type, id_number, id_file, guest_id, sort) VALUES (?,?,?,?,?,?,?,?)')
          .run(...vals, g.id, i);
      }
    }

    if (e.require_id && (files.has('id_file') || b.id_type || b.id_number)) {
      if (files.has('id_file')) S.removeUpload('ids', g.id_file);
      db.prepare(`UPDATE guests SET id_type = COALESCE(?, id_type), id_number = COALESCE(?, id_number), id_file = COALESCE(?, id_file) WHERE id = ?`)
        .run(b.id_type || null, b.id_number ? String(b.id_number).replace(/\s+/g, '').slice(0, 30) : null, files.get('id_file') || null, g.id);
    }
    if (files.size) {
      db.prepare("UPDATE guests SET id_consent_at = datetime('now') WHERE id = ?").run(g.id);
      S.logActivity(e.id, g.id, 'Guest', 'id', `${files.size} ID document${files.size === 1 ? '' : 's'} uploaded`);
    }
  } else dropFiles();

  S.logActivity(e.id, g.id, 'Guest', 'rsvp', `${g.responded_at ? 'Updated RSVP' : 'RSVP received'}: ${summary.join(', ')}`);
  res.redirect(`/i/${g.token}?done=1`);
});

module.exports = r;
