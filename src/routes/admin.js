const express = require('express');
const multer = require('multer');
const db = require('../db');
const layout = require('../layout');
const { requireRole, hashPassword } = require('../auth');
const { html, token, parseCsv, maskId, fmtDate } = require('../util');
const S = require('../shared');
const T = require('../tenancy');
const W = require('../wedding');
const F = require('../fields');
const V = require('../vault');

const r = express.Router();
r.use(requireRole('admin'));

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const getEvent = T.getEvent;
const back = (res, url, msg) => res.redirect(`${url}${msg ? `${url.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}` : ''}`);
const page = (req, title, body) => layout({ title, user: req.user, body, flash: req.query.msg });

function eventForm(e = {}) {
  return html`
  <label>Couple / event title<input name="title" required value="${e.title || ''}" placeholder="Aarav & Diya"></label>
  <div class="row">
    <label>Client name<input name="client_name" value="${e.client_name || ''}" placeholder="Mrs. Sharma (bride's mother)"></label>
    <label>Client phone<input name="client_phone" value="${e.client_phone || ''}" inputmode="tel"></label>
  </div>
  <div class="row">
    <label>Wedding date<input type="date" name="event_date" value="${e.event_date || ''}"></label>
    <label>City<input name="city" value="${e.city || ''}" placeholder="Udaipur"></label>
  </div>
  <label>Venue<input name="venue" value="${e.venue || ''}" placeholder="The Leela Palace"></label>
  <label>Welcome note on RSVP page<textarea name="welcome_note" rows="3" placeholder="We would be honoured by your presence…">${e.welcome_note || ''}</textarea></label>
  <label>WhatsApp invite message <small>placeholders: {name} {title} {date} {venue} {link}</small>
    <textarea name="invite_message" rows="6">${e.invite_message || S.DEFAULT_INVITE}</textarea></label>
  <label class="check"><input type="checkbox" name="require_id" value="1" ${e.require_id ?? 1 ? 'checked' : ''}> Collect government ID from attending guests (for hotel check-in / venue security)</label>
  <label class="check"><input type="checkbox" name="collect_travel" value="1" ${e.collect_travel ?? 1 ? 'checked' : ''}> Collect arrival, departure &amp; stay details</label>
  <fieldset><legend>ID documents</legend>
    <p class="muted small">Every attending adult is asked for one government ID for check-in. Tick any extra documents you also need (e.g. PAN for foreign-exchange or airline bookings).
      Aadhaar numbers are always stored masked (last 4 digits); all ID photos are encrypted.</p>
    ${V.DOC_TYPES.filter((t) => t !== 'Other').map((t) => html`<label class="check inline-check"><input type="checkbox" name="extra_docs" value="${t}" ${V.extraDocTypes(e).includes(t) ? 'checked' : ''}> ${t}</label>`)}
    <label>Auto-delete all IDs this many days after the wedding <small>(recommended 30; empty = keep until deleted manually)</small>
      <input type="number" name="id_retention_days" min="1" max="3650" value="${e.id_retention_days ?? ''}" placeholder="30"></label>
  </fieldset>
  <label>Client dashboard PIN <small>(optional — the client must enter it once per device; leave blank for link-only access)</small>
    <input name="client_pin" inputmode="numeric" maxlength="12" value="${e.client_pin || ''}" autocomplete="off"></label>`;
}

const eventFields = (b) => [b.title?.trim(), b.client_name || null, b.client_phone || null, b.event_date || null,
  b.venue || null, b.city || null, b.invite_message || null, b.welcome_note || null, b.require_id ? 1 : 0, b.collect_travel ? 1 : 0,
  b.client_pin?.trim() || null];

function saveIdSettings(eventId, b) {
  const docs = [].concat(b.extra_docs || []).filter((t) => V.DOC_TYPES.includes(t));
  const days = parseInt(b.id_retention_days, 10);
  db.prepare('UPDATE events SET extra_docs = ?, id_retention_days = ? WHERE id = ?').run(docs.join(',') || null, days > 0 ? days : null, eventId);
}

// ---- Weddings list ----
const eventCards = (events, { partner } = {}) => html`<div class="cards">${events.map((e) => html`
  <a class="card event-card" href="/admin/events/${e.id}">
    ${partner ? html`<p class="eyebrow">${e.org_name}</p>` : ''}
    <h2>${e.title}</h2>
    <p class="muted">${[fmtDate(e.event_date), e.venue, e.city].filter(Boolean).join(' · ')}</p>
    <p>${e.guests || 0} guests · ${e.responded || 0} responded · <strong>${e.yes || 0} attending</strong></p>
    ${!partner && e.service_status !== 'none' ? html`<p><span class="badge svc-${e.service_status}">RSVP desk: ${T.SERVICE_LABEL[e.service_status]}</span></p>` : ''}
  </a>`)}</div>`;

const EVENT_LIST_SQL = `SELECT e.*, o.name org_name, COUNT(g.id) guests, SUM(g.rsvp_status != 'pending') responded,
    SUM(g.rsvp_status = 'yes') yes FROM events e JOIN orgs o ON o.id = e.org_id LEFT JOIN guests g ON g.event_id = e.id`;

r.get('/', (req, res) => {
  const u = req.user;
  const own = db.prepare(`${EVENT_LIST_SQL} WHERE e.org_id = ? GROUP BY e.id ORDER BY e.event_date IS NULL, e.event_date`).all(u.org_id);
  const partner = u.platform ? db.prepare(`${EVENT_LIST_SQL} WHERE e.org_id != ? AND e.service_status = 'active'
    GROUP BY e.id ORDER BY e.event_date IS NULL, e.event_date`).all(u.org_id) : [];
  const requests = u.platform ? db.prepare("SELECT COUNT(*) n FROM events WHERE service_status = 'requested'").get().n : 0;
  const unmatched = u.platform ? db.prepare('SELECT COUNT(*) n FROM calls WHERE event_id IS NULL').get().n : 0;
  res.send(page(req, 'Weddings', html`
    <div class="head"><h1>Weddings</h1>${u.platform ? html`<div class="actions"><a class="btn" href="/admin/platform">Platform dashboard</a><a class="btn" href="/admin/whatsapp">WhatsApp setup</a></div>` : ''}</div>
    ${requests ? html`<p class="flash"><a href="/admin/platform">🤝 ${requests} wedding${requests === 1 ? '' : 's'} requested the Candid Dulhan RSVP desk →</a></p>` : ''}
    ${unmatched ? html`<p class="flash warn"><a href="/admin/unmatched">${unmatched} call recording${unmatched === 1 ? '' : 's'} could not be matched to a guest →</a></p>` : ''}
    ${own.length ? eventCards(own) : html`<p class="muted">No weddings yet. Create your first one below.</p>`}
    <details class="card" ${own.length ? '' : 'open'}><summary><strong>+ New wedding</strong></summary>
      <form method="post" action="/admin/events" class="form">${eventForm()}<button class="primary">Create wedding</button></form>
    </details>
    ${partner.length ? html`<h2>Partner weddings <small class="muted">(RSVP desk service active)</small></h2>${eventCards(partner, { partner: true })}` : ''}
    <h2>Team performance <small class="muted">(all weddings)</small></h2>
    ${S.teamTable(S.teamStats(null, T.orgTeam(u.org_id)))}`));
});

r.post('/events', (req, res) => {
  if (!req.body.title?.trim()) return back(res, '/admin', 'Title is required');
  const info = db.prepare(`INSERT INTO events (title, client_name, client_phone, event_date, venue, city, invite_message,
    welcome_note, require_id, collect_travel, client_pin, client_token, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(...eventFields(req.body), token(18), req.user.org_id);
  saveIdSettings(info.lastInsertRowid, req.body);
  back(res, `/admin/events/${info.lastInsertRowid}`, 'Wedding created. Add guests below.');
});

// ---- Wedding detail ----
r.get('/events/:id', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  const owner = T.ownsEvent(req.user, e);
  const filter = { status: req.query.status, side: req.query.side, q: req.query.q, assigned: req.query.assigned, due: req.query.due };
  const guests = S.listGuests(e.id, filter);
  const team = T.eventTeam(e);
  const fns = W.functionsOf(e.id);
  const answers = W.guestFunctionMap(e.id);
  const recent = db.prepare(`SELECT a.*, g.name guest_name FROM activities a LEFT JOIN guests g ON g.id = a.guest_id
    WHERE a.event_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 15`).all(e.id);
  res.send(page(req, e.title, html`
    <div class="head">
      <div><h1>${e.title}</h1><p class="muted">${[fmtDate(e.event_date), e.venue, e.city].filter(Boolean).join(' · ')}
        ${e.client_name ? html` · Client: ${e.client_name}` : ''}</p></div>
      <div class="actions">
        ${owner ? html`<a class="btn" href="/admin/events/${e.id}/settings">Settings</a>` : ''}
        <a class="btn" href="/admin/events/${e.id}/export.csv">Export CSV</a>
        <a class="btn" href="/caller/${e.id}">Caller view</a>
      </div>
    </div>
    <div class="card share">
      <div><strong>Client dashboard link</strong> <span class="muted">— share with the couple/family. Read-only; shows IDs &amp; recordings.</span></div>
      <div class="copyrow"><input readonly value="${S.clientUrl(req, e)}"><button type="button" data-copy>Copy</button>
      <a class="btn" target="_blank" href="${S.clientUrl(req, e)}">Open</a></div>
    </div>
    ${W.eventNav(e, 'guests', { owner })}
    ${serviceCard(req, e)}
    ${(() => { const al = require('../smart').alerts(e); return al.length ? html`<div class="card"><div class="head"><h3>🚦 Needs attention</h3>
      <a class="btn sm" href="/admin/events/${e.id}/insights">All alerts, AI report &amp; downloads →</a></div>
      ${require('./smart').alertList(al, { limit: 3 })}</div>` : ''; })()}
    ${S.statCards(S.stats(e.id))}
    ${W.functionTable(e.id)}

    <div class="grid-crm">
      <div class="card"><h3>Team on this wedding</h3>${S.teamTable(S.teamStats(e.id, team))}</div>
      <div class="card"><h3>Recent activity</h3>${S.timeline(recent, { showGuest: true })}</div>
    </div>

    <div class="grid2">
      <details class="card"><summary><strong>+ Add guest</strong></summary>
        <form method="post" action="/admin/events/${e.id}/guests" class="form">
          <div class="row"><label>Name<input name="name" required></label><label>Phone (WhatsApp)<input name="phone" inputmode="tel"></label></div>
          <div class="row"><label>Side<select name="side"><option></option><option>Bride</option><option>Groom</option></select></label>
            <label>Group<input name="group_name" placeholder="Family / Friends / Office"></label></div>
          <div class="row"><label>Invited for (people)<input type="number" name="max_pax" min="1" value="1"></label><label>Email<input type="email" name="email"></label></div>
          <button class="primary">Add guest</button>
        </form>
      </details>
      <details class="card"><summary><strong>⇪ Bulk upload guests (Excel or CSV)</strong></summary>
        <form method="post" action="/admin/events/${e.id}/import" enctype="multipart/form-data" class="form">
          <p class="muted">Upload your whole guest list at once — names, mobiles, family members, functions, travel, hotel, food and more.
            <a href="/admin/events/${e.id}/import-template.xlsx">⬇ Download the Excel template</a> (has dropdowns and examples).</p>
          <input type="file" name="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required>
          <label class="check"><input type="checkbox" name="update" value="1" checked> Update guests already on the list (matched by mobile) — empty cells keep saved values</label>
          <button class="primary">Upload</button>
        </form>
      </details>
    </div>

    <h2>Guests <small class="muted">(${guests.length})</small></h2>
    ${S.filterBar(e.id, filter, { me: req.user.uid, crm: true })}
    <form method="post" action="/admin/events/${e.id}/assign" id="bulk">
    ${team.length ? html`<div class="bulkbar">
      <span><strong data-selcount>0</strong> selected</span>
      <select name="user_id"><option value="">Assign to…</option><option value="none">— Unassign —</option>
        ${team.map((u) => html`<option value="${u.id}">${u.name}</option>`)}</select>
      <button name="mode" value="selected">Assign selected</button>
      <button name="mode" value="auto" class="btn" data-confirm-click="Share all unassigned guests who haven’t replied equally among active team members?">⚖ Auto-split unassigned</button>
    </div>` : ''}
    ${fns.length ? html`<div class="bulkbar">
      <span><strong data-selcount>0</strong> selected</span>
      <select name="function_id"><option value="">Function…</option>${fns.map((f) => html`<option value="${f.id}">${f.name}</option>`)}</select>
      <button name="mode" value="invite_fn">Invite to function</button>
      <button name="mode" value="uninvite_fn">Remove from function</button>
    </div>` : ''}
    <div class="bulkbar">
      <span><strong data-selcount>0</strong> selected</span>
      <select name="wa_purpose"><option value="">WhatsApp message…</option>${Object.entries(require('../whatsapp').TEMPLATES).filter(([, t]) => t.params).map(([k, t]) => html`<option value="${k}">${t.label}</option>`)}</select>
      <button name="mode" value="wa" data-confirm-click="Send this WhatsApp message to the selected guests?">💬 Send to selected</button>
    </div>
    <div class="table-wrap"><table class="guests">
      <tr>${html`<th><input type="checkbox" data-selall aria-label="Select all"></th>`}<th>Guest</th><th>Side / group</th><th>RSVP</th><th>People</th><th>Arrival</th><th>ID</th><th>Calls / follow-up</th><th>Owner</th><th>Invite</th></tr>
      ${guests.map((g) => html`<tr>
        <td><input type="checkbox" name="guest_ids" value="${g.id}" data-sel></td>
        <td><a href="/admin/guests/${g.id}"><strong>${g.name}</strong></a><br><small class="muted">${g.phone || ''}</small></td>
        <td>${g.side || ''}<br><small class="muted">${g.group_name || ''}</small></td>
        <td>${S.badge(g.rsvp_status)}${fns.length ? html`<br>${W.functionChips(fns, answers.get(g.id))}` : ''}</td>
        <td>${g.rsvp_status === 'yes' ? g.pax ?? 1 : '–'} / ${g.max_pax}</td>
        <td>${fmtDate(g.arrival_date)}${g.arrival_mode ? html`<br><small class="muted">${[g.arrival_time, g.arrival_mode].filter(Boolean).join(' · ')}</small>` : ''}</td>
        <td>${g.id_file ? html`<a href="/admin/guests/${g.id}/id-file" target="_blank">${g.id_type || 'View'}</a>` : g.id_type ? g.id_type : '–'}</td>
        <td>${g.call_count || ''}${g.last_outcome ? html`<br><small class="muted">${S.OUTCOMES[g.last_outcome] || g.last_outcome}</small>` : ''}
          ${g.follow_up_at ? html`<br><small class="${S.isOverdue(g.follow_up_at) ? 'overdue' : 'muted'}">⏰ ${fmtDate(g.follow_up_at)}</small>` : ''}</td>
        <td>${g.assignee || html`<span class="muted">—</span>`}</td>
        <td class="nowrap">
          ${g.phone ? html`<a class="btn sm wa" target="_blank" href="/admin/guests/${g.id}/whatsapp">${g.invited_at ? 'Resend' : 'WhatsApp'}</a>` : ''}
          <button type="button" class="btn sm" data-copy="${S.inviteUrl(req, g)}">Link</button>
          ${g.invited_at ? html`<br><small class="muted">sent ${fmtDate(g.invited_at)}</small>` : ''}
        </td>
      </tr>`)}
    </table></div>
    </form>

    <h2>Call log</h2>
    ${S.callsTable(S.eventCalls(e.id), (c) => `/admin/calls/${c.id}/recording`)}

    ${owner ? html`<form method="post" action="/admin/events/${e.id}/delete" class="danger-zone" data-confirm="Delete this wedding, all guests, IDs and recordings? This cannot be undone.">
      <button class="danger">Delete wedding</button>
    </form>` : ''}`));
});

// ---- Candid Dulhan RSVP-desk service (the paid add-on) ----
function serviceCard(req, e) {
  const u = req.user;
  if (u.platform && e.org_id === u.org_id) return ''; // our own wedding: we are the service
  const staff = T.eventStaff(e.id);
  if (u.platform) {
    const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(e.org_id);
    const ids = new Set(staff.map((x) => x.id));
    return html`<div class="card service active"><strong>🤝 Partner wedding</strong> for <strong>${org.name}</strong>
      ${org.contact_name || org.phone ? html` · ${[org.contact_name, org.phone].filter(Boolean).join(' · ')}` : ''}
      ${e.service_note ? html`<p class="muted small">Their brief: ${e.service_note}</p>` : ''}
      ${u.role === 'admin' ? html`<form method="post" action="/admin/platform/events/${e.id}/staff" class="inline-form staff-form">
        <span>Dedicated staff:</span>${T.orgTeam(db.platformOrgId).map((p) => html`<label class="check inline-check">
          <input type="checkbox" name="staff" value="${p.id}" ${ids.has(p.id) ? 'checked' : ''}> ${p.name}</label>`)}
        <button class="sm">Save</button></form>` : html`<p class="muted small">Dedicated staff: ${staff.map((x) => x.name).join(', ')}</p>`}</div>`;
  }
  const st = e.service_status;
  if (st === 'active') return html`<div class="card service active"><strong>🤝 Candid Dulhan RSVP desk is working on this wedding.</strong>
    ${staff.length ? html`<span>Your dedicated guest managers: <strong>${staff.map((x) => x.name).join(', ')}</strong>.</span>` : ''}
    <span class="muted">They call your guests on your behalf; everything they do shows up here and on your client’s dashboard.</span>
    <form method="post" action="/admin/events/${e.id}/service" class="inline" data-confirm="Stop the RSVP desk service for this wedding? Their team will lose access.">
      <button name="action" value="end" class="btn sm">End service</button></form></div>`;
  if (st === 'requested') return html`<div class="card service"><strong>⏳ RSVP desk requested.</strong>
    <span class="muted">Candid Dulhan will contact you shortly to confirm scope and pricing.</span>
    <form method="post" action="/admin/events/${e.id}/service" class="inline"><button name="action" value="cancel" class="btn sm">Cancel request</button></form></div>`;
  return html`<details class="card service"><summary><strong>🤝 Short on time? Let Candid Dulhan’s RSVP desk call your guests</strong>
      ${st === 'declined' ? html` <span class="muted">(previous request declined — you can ask again)</span>` : ''}</summary>
    <p class="muted">Our trained team calls every guest, collects RSVPs, travel and IDs, and logs recorded calls here — you and your client watch progress live. You stay the planner; we work under your brand.</p>
    <form method="post" action="/admin/events/${e.id}/service" class="form">
      <label>What do you need? <small>(guest count, deadline, languages, hotel/travel coordination…)</small>
        <textarea name="note" rows="3" required placeholder="~450 guests, calls in Hindi & Marwari, all RSVPs by 20 Nov, need rooming list for 2 hotels"></textarea></label>
      <button name="action" value="request" class="primary">Request RSVP desk</button>
    </form></details>`;
}

r.post('/events/:id/service', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  const u = req.user, action = req.body.action;
  const set = (status, note) => {
    db.prepare("UPDATE events SET service_status = ?, service_note = COALESCE(?, service_note), service_updated_at = datetime('now') WHERE id = ?")
      .run(status, note ?? null, e.id);
  };
  const owner = T.ownsEvent(u, e);
  if (owner && action === 'request' && ['none', 'declined'].includes(e.service_status)) {
    set('requested', String(req.body.note || '').slice(0, 2000));
    S.logActivity(e.id, null, u.name, 'service', 'Requested the Candid Dulhan RSVP desk');
  } else if (owner && action === 'cancel' && e.service_status === 'requested') {
    set('none');
    S.logActivity(e.id, null, u.name, 'service', 'Cancelled the RSVP desk request');
  } else if (owner && action === 'end' && e.service_status === 'active') {
    set('none');
    // Candid Dulhan callers lose access, so hand their open guests back.
    db.prepare('UPDATE guests SET assigned_to = NULL WHERE event_id = ? AND assigned_to IN (SELECT id FROM users WHERE org_id = ?)').run(e.id, db.platformOrgId);
    T.setEventStaff(e.id, []);
    S.logActivity(e.id, null, u.name, 'service', 'Ended the RSVP desk service');
  } else return back(res, `/admin/events/${e.id}`, 'That action isn’t available right now');
  back(res, `/admin/events/${e.id}`, 'Updated');
});

r.post('/events/:id/assign', async (req, res, next) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  if (req.body.mode === 'wa') {
    const WA = require('../whatsapp');
    const ew = WA.eventWithOrg(e.id);
    const purpose = req.body.wa_purpose;
    if (!WA.TEMPLATES[purpose]?.params) return back(res, `/admin/events/${e.id}`, 'Choose a WhatsApp message');
    if (!WA.canSend(ew)) return back(res, `/admin/events/${e.id}`, 'Bulk WhatsApp needs the Candid Dulhan RSVP desk for this wedding');
    const guests = WA.audienceGuests(e.id, 'selected', req.body.guest_ids);
    if (!guests.length) return back(res, `/admin/events/${e.id}`, 'Select guests with a mobile number');
    try {
      const r2 = await WA.runCampaign(e.id, purpose, guests, { who: req.user.name, audience: 'selected' });
      return back(res, `/admin/events/${e.id}`, `WhatsApp ${WA.live() ? 'sent' : '(test mode)'} to ${r2.sent} guest${r2.sent === 1 ? '' : 's'}${r2.failed ? `, ${r2.failed} failed` : ''}`);
    } catch (err) { return next(err); }
  }
  const team = T.eventTeam(e);
  const byId = new Map(team.map((u) => [u.id, u]));
  const setOwner = db.prepare('UPDATE guests SET assigned_to = ? WHERE id = ? AND event_id = ?');
  let n = 0;
  db.exec('BEGIN');
  try {
    if (req.body.mode === 'invite_fn' || req.body.mode === 'uninvite_fn') {
      const f = db.prepare('SELECT * FROM functions WHERE id = ? AND event_id = ?').get(req.body.function_id, e.id);
      const ids = [].concat(req.body.guest_ids || []).map(Number).filter(Boolean);
      if (!f || !ids.length) throw Object.assign(new Error('Pick guests and a function'), { user: true });
      const inGuest = db.prepare('SELECT 1 FROM guests WHERE id = ? AND event_id = ?');
      for (const id of ids) {
        if (!inGuest.get(id, e.id)) continue;
        if (req.body.mode === 'invite_fn') n += db.prepare('INSERT OR IGNORE INTO guest_functions (guest_id, function_id) VALUES (?,?)').run(id, f.id).changes;
        else n += db.prepare('DELETE FROM guest_functions WHERE guest_id = ? AND function_id = ?').run(id, f.id).changes;
        W.syncOverall(id);
      }
      db.exec('COMMIT');
      return back(res, `/admin/events/${e.id}`, `${req.body.mode === 'invite_fn' ? 'Invited' : 'Removed'} ${n} guest${n === 1 ? '' : 's'} ${req.body.mode === 'invite_fn' ? 'to' : 'from'} ${f.name}`);
    }
    if (req.body.mode === 'auto') {
      const callers = team.filter((u) => u.role === 'caller').length ? team.filter((u) => u.role === 'caller') : team;
      if (!callers.length) throw Object.assign(new Error('Add team members first'), { user: true });
      const load = new Map(callers.map((u) => [u.id, db.prepare(`SELECT COUNT(*) n FROM guests WHERE event_id = ? AND assigned_to = ?
        AND rsvp_status IN ('pending','maybe')`).get(e.id, u.id).n]));
      const todo = db.prepare(`SELECT id, name FROM guests WHERE event_id = ? AND assigned_to IS NULL AND rsvp_status IN ('pending','maybe')
        ORDER BY side, group_name, name`).all(e.id);
      for (const g of todo) {
        const [uid] = [...load.entries()].sort((a, b) => a[1] - b[1])[0];
        setOwner.run(uid, g.id, e.id);
        load.set(uid, load.get(uid) + 1);
        S.logActivity(e.id, g.id, req.user.name, 'assign', `Assigned to ${byId.get(uid).name} (auto-split)`);
        n++;
      }
    } else {
      const ids = [].concat(req.body.guest_ids || []).map(Number).filter(Boolean);
      const uid = req.body.user_id === 'none' ? null : Number(req.body.user_id) || undefined;
      if (uid === undefined || !ids.length) throw Object.assign(new Error('Pick guests and a team member'), { user: true });
      if (uid && !byId.has(uid)) throw Object.assign(new Error('Unknown team member'), { user: true });
      for (const id of ids) {
        if (setOwner.run(uid, id, e.id).changes) {
          S.logActivity(e.id, id, req.user.name, 'assign', uid ? `Assigned to ${byId.get(uid).name}` : 'Unassigned');
          n++;
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    if (err.user) return back(res, `/admin/events/${e.id}`, err.message);
    throw err;
  }
  back(res, `/admin/events/${e.id}`, `Assigned ${n} guest${n === 1 ? '' : 's'}`);
});

r.get('/events/:id/settings', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  if (!T.ownsEvent(req.user, e)) return back(res, `/admin/events/${e.id}`, 'Only the company that owns this wedding can do that');
  res.send(page(req, `Settings · ${e.title}`, html`
    <h1>${e.title}</h1>${W.eventNav(e, 'settings', { owner: true })}
    <form method="post" action="/admin/events/${e.id}/settings" class="form card">${eventForm(e)}
      <label class="check"><input type="checkbox" name="rotate_client_link" value="1"> Generate a new client dashboard link (the old link stops working)</label>
      <button class="primary">Save</button></form>
    <form method="post" action="/admin/events/${e.id}/purge-ids" class="card danger-zone left" data-confirm="Permanently delete every ID photo and ID number for this wedding? This cannot be undone.">
      <strong>Privacy:</strong> delete all ID documents for this wedding now (e.g. once check-in is done). <button class="danger sm">Delete all IDs</button></form>`));
});

r.post('/events/:id/settings', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  if (!T.ownsEvent(req.user, e)) return back(res, `/admin/events/${e.id}`, 'Only the company that owns this wedding can do that');
  db.prepare(`UPDATE events SET title=?, client_name=?, client_phone=?, event_date=?, venue=?, city=?, invite_message=?,
    welcome_note=?, require_id=?, collect_travel=?, client_pin=?, client_token=? WHERE id=?`)
    .run(...eventFields(req.body), req.body.rotate_client_link ? token(18) : e.client_token, e.id);
  saveIdSettings(e.id, req.body);
  back(res, `/admin/events/${e.id}`, 'Saved');
});

r.post('/events/:id/delete', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  if (!T.ownsEvent(req.user, e)) return back(res, `/admin/events/${e.id}`, 'Only the company that owns this wedding can do that');
  for (const g of db.prepare('SELECT id_file FROM guests WHERE event_id = ?').all(e.id)) S.removeUpload('ids', g.id_file);
  V.purgeEvent(e.id);
  for (const c of db.prepare('SELECT recording_file FROM calls WHERE event_id = ?').all(e.id)) S.removeUpload('recordings', c.recording_file);
  db.prepare('DELETE FROM events WHERE id = ?').run(e.id);
  back(res, '/admin', `Deleted ${e.title}`);
});

r.get('/events/:id/export.csv', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="guests-${e.id}.csv"`);
  res.send('﻿' + S.guestsCsv(e.id, { withIdNumbers: true }));
});

// ---- Guests ----
const insertGuest = db.prepare(`INSERT INTO guests (event_id, name, phone, email, side, group_name, max_pax, token)
  VALUES (?,?,?,?,?,?,?,?)`);

r.post('/events/:id/guests', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  if (!req.body.name?.trim()) return back(res, `/admin/events/${e.id}`, 'Name is required');
  const b = req.body;
  const info = insertGuest.run(e.id, b.name.trim(), b.phone?.trim() || null, b.email?.trim() || null, b.side || null,
    b.group_name?.trim() || null, Math.max(1, Number(b.max_pax) || 1), token());
  W.inviteGuest(info.lastInsertRowid, W.functionsOf(e.id).map((f) => f.id));
  S.logActivity(e.id, info.lastInsertRowid, req.user.name, 'import', 'Added to guest list');
  back(res, `/admin/events/${e.id}`, `Added ${b.name.trim()}`);
});

r.post('/events/:id/import', csvUpload.single('file'), async (req, res, next) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  if (!req.file) return back(res, `/admin/events/${e.id}`, 'Choose an Excel or CSV file');
  try {
    const r2 = await require('../importer').importGuests(e, req.file, { update: !!req.body.update, who: req.user.name });
    if (r2.error) return back(res, `/admin/events/${e.id}`, r2.error);
    const parts = [`${r2.added} added`, `${r2.updated} updated`];
    if (r2.members) parts.push(`${r2.members} family members`);
    if (r2.hotelsCreated) parts.push(`${r2.hotelsCreated} new hotels`);
    if (r2.skipped.length) parts.push(`${r2.skipped.length} skipped — ${r2.skipped.slice(0, 3).join('; ')}${r2.skipped.length > 3 ? '…' : ''}`);
    back(res, `/admin/events/${e.id}`, `Bulk upload done: ${parts.join(', ')}`);
  } catch (err) {
    if (/xls|zip|Excel|central directory/i.test(err.message)) return back(res, `/admin/events/${e.id}`, `Could not read the file: ${err.message}`);
    next(err);
  }
});

r.get('/events/:id/import-template.xlsx', async (req, res, next) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  try {
    const buf = await require('../importer').template(e);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="guest-list-template.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

r.get('/guests/:id/whatsapp', (req, res) => {
  const { g, e } = T.loadGuest(req, res, req.params.id);
  if (!g) return;
  if (!g.phone) return res.status(404).send('Guest has no phone number');
  db.prepare("UPDATE guests SET invited_at = datetime('now') WHERE id = ?").run(g.id);
  S.logActivity(g.event_id, g.id, req.user.name, 'invite', g.invited_at ? 'WhatsApp invite re-sent' : 'WhatsApp invite sent');
  res.redirect(S.waUrl(req, e, g));
});

r.get('/guests/:id', (req, res) => {
  const { g, e } = T.loadGuest(req, res, req.params.id);
  if (!g) return;
  const calls = db.prepare('SELECT c.*, ? guest_name FROM calls c WHERE guest_id = ? ORDER BY called_at DESC').all(g.name, g.id);
  const team = T.eventTeam(e);
  const hotels = F.hotelsOf(e.id);
  const fns = W.functionsOf(e.id);
  const answers = W.guestFunctions(g.id);
  const members = W.membersOf(g.id);
  const cfs = F.customFields(e.id);
  const cvals = F.customValues(g.id);
  const sel = (name, opts, v) => html`<select name="${name}">${opts.map(([k, l]) => html`<option value="${k}" ${String(v ?? '') === String(k) ? 'selected' : ''}>${l}</option>`)}</select>`;
  const memberRow = (m = {}) => html`
    <div class="fields">
      <label>Name<input name="name" value="${m.name || ''}" ${m.id ? '' : 'required'}></label>
      <label>Relation<input name="relation" value="${m.relation || ''}" placeholder="Wife, son…"></label>
      <label>Age group${sel('age_group', [['', ''], ['Adult', 'Adult'], ['Child', 'Child'], ['Senior', 'Senior']], m.age_group)}</label>
      <label>Gender${sel('gender', [['', ''], ['F', 'Female'], ['M', 'Male'], ['Other', 'Other']], m.gender)}</label>
      <label>Phone<input name="phone" value="${m.phone || ''}"></label>
      <label>Food${sel('dietary', F.FIELD.dietary.options, m.dietary)}</label>
      <label>ID type${sel('id_type', [['', ''], ...S.ID_TYPES.map((t) => [t, t])], m.id_type)}</label>
      <label>ID number<input name="id_number" placeholder="${m.id_number ? maskId(m.id_number) : ''}" autocomplete="off"></label>
      <label>ID photo<input type="file" name="id_file" accept="image/*,application/pdf"></label>
    </div>`;
  res.send(page(req, g.name, html`
    <p><a href="/admin/events/${e.id}">← ${e.title}</a></p>
    <div class="head"><h1>${[g.salutation, g.name].filter(Boolean).join(' ')} ${S.badge(g.rsvp_status)}</h1>
      <div class="actions">
        ${g.phone ? html`<a class="btn" href="tel:${g.phone}">Call</a><a class="btn wa" target="_blank" href="/admin/guests/${g.id}/whatsapp">WhatsApp invite</a>` : ''}
        <a class="btn" target="_blank" href="/i/${g.token}">Open RSVP page</a>
      </div></div>
    <p class="muted">${[g.relation, g.side, g.group_name, g.category, g.city].filter(Boolean).join(' · ')}</p>

    ${require('../ai').enabled() ? html`<details class="card ai-card"><summary><strong>✨ Write a WhatsApp message with AI</strong>
        <span class="muted">personalised from this guest’s RSVP, travel and stay</span></summary>
      <form class="ai-msg form" data-ai-msg="/admin/guests/${g.id}/ai/message">
        <div class="fields">
          <label>Purpose<select name="purpose">${Object.entries({ reminder: 'RSVP reminder', invite: 'Personal invitation', id_request: 'Ask for IDs', travel: 'Ask for travel details', itinerary: 'Send itinerary', thanks: 'Thank you' }).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
          <label>Language<select name="language"><option>English</option><option>Hinglish</option><option>Hindi</option></select></label>
        </div>
        <button class="primary sm">Write message</button>
        <div class="ai-out" hidden><textarea rows="7"></textarea>
          <div class="actions"><button type="button" class="btn sm" data-copy-area>Copy</button><a class="btn sm wa" target="_blank" data-wa>Send on WhatsApp</a></div></div>
      </form></details>` : ''}

    <form method="post" action="/admin/guests/${g.id}" class="form card">
      ${fns.length ? html`<fieldset><legend>RSVP by function</legend>
        <div class="table-wrap flat"><table class="mini"><tr><th>Function</th><th>Invited</th><th>Answer</th><th>People</th></tr>
        ${fns.map((f) => { const a = answers.get(f.id); return html`<tr>
          <td><strong>${f.name}</strong><br><small class="muted">${[fmtDate(f.date), f.time].filter(Boolean).join(' · ')}</small></td>
          <td><input type="checkbox" name="fn_inv_${f.id}" value="1" ${a ? 'checked' : ''}></td>
          <td>${sel(`fn_rsvp_${f.id}`, Object.entries(W.RSVP_LABEL), a?.rsvp || 'pending')}</td>
          <td><input type="number" name="fn_pax_${f.id}" min="0" max="${g.max_pax}" value="${a?.pax ?? ''}" size="3"></td></tr>`; })}
        </table></div></fieldset>`
      : html`<fieldset><legend>RSVP</legend><div class="fields">
          <label>Status${sel('rsvp_status', Object.entries(S.STATUS_LABEL), g.rsvp_status)}</label>
          <label>People attending<input type="number" min="0" name="pax" value="${g.pax ?? ''}"></label></div>
          <p class="muted small">Add functions (Haldi, Sangeet…) to track RSVPs per function.</p></fieldset>`}
      <fieldset><legend>Ownership &amp; follow-up</legend><div class="fields">
        <label>Owner${sel('assigned_to', [['', '— Unassigned —'], ...team.map((u) => [u.id, u.name])], g.assigned_to)}</label>
        <label>Follow up on<input type="datetime-local" name="follow_up_at" value="${S.followUpToInput(g.follow_up_at)}"></label></div></fieldset>
      ${F.SECTIONS.map((sec) => F.formSection(sec, g, { hotels }))}
      ${cfs.length ? html`<fieldset><legend>Custom fields</legend><div class="fields">
        ${cfs.map((cf) => html`<label>${cf.label}${F.customInput(cf, cvals.get(cf.id))}</label>`)}</div></fieldset>` : ''}
      <button class="primary big">Save guest</button>
    </form>

    <div class="card" id="members"><h3>Family members travelling <small class="muted">(${members.length + 1} of ${g.max_pax} incl. ${g.name})</small></h3>
      ${members.map((m) => html`<details class="member"><summary><strong>${m.name}</strong>
          <span class="muted">${[m.relation, m.age_group, m.dietary].filter(Boolean).join(' · ')}</span>
          ${m.id_file ? html` · <a href="/admin/members/${m.id}/id-file" target="_blank">${m.id_type || 'ID'} ${maskId(m.id_number)}</a>` : m.id_type ? html` · <span class="muted">${m.id_type} (no photo)</span>` : html` · <span class="muted">no ID</span>`}</summary>
        <form method="post" action="/admin/members/${m.id}" enctype="multipart/form-data" class="form">${memberRow(m)}
          <div class="actions"><button class="primary sm" name="action" value="save">Save</button>
          <button class="danger sm" name="action" value="delete" data-confirm-click="Remove ${m.name}?">Remove</button></div></form></details>`)}
      <details class="member"><summary><strong>+ Add family member</strong></summary>
        <form method="post" action="/admin/guests/${g.id}/members" enctype="multipart/form-data" class="form">${memberRow()}
          <button class="primary sm">Add member</button></form></details>
    </div>

    <div class="card" id="documents"><h3>🔐 ID documents <small class="muted">(encrypted · every view is logged)</small></h3>
      ${(() => {
        const docs = V.docsOf(g.id);
        const rows = [
          { who: g.name, type: g.id_type, number: g.id_number, href: g.id_file ? `/admin/guests/${g.id}/id-file` : null, primary: true },
          ...members.map((m) => ({ who: m.name, type: m.id_type, number: m.id_number, href: m.id_file ? `/admin/members/${m.id}/id-file` : null, primary: true })),
          ...docs.map((d) => ({ who: d.member_id ? members.find((m) => m.id === d.member_id)?.name : g.name, type: d.doc_type, number: d.number,
            href: d.file ? `/admin/docs/${d.id}/file` : null, doc: d })),
        ].filter((r) => r.type || r.href);
        return rows.length ? html`<div class="table-wrap flat"><table class="mini"><tr><th>Person</th><th>Document</th><th>Number</th><th>Photo</th><th></th></tr>
          ${rows.map((r) => html`<tr><td>${r.who}</td><td>${r.type || 'ID'}${r.primary ? html` <small class="muted">check-in</small>` : ''}</td>
            <td><code>${r.number || '—'}</code></td><td>${r.href ? html`<a target="_blank" href="${r.href}">View</a>` : html`<span class="muted">none</span>`}</td>
            <td>${r.doc ? html`<form method="post" action="/admin/docs/${r.doc.id}/delete" class="inline" data-confirm="Delete this ${r.type}?"><button class="danger sm">Delete</button></form>` : ''}</td></tr>`)}
        </table></div>
        ${g.id_consent_at ? html`<p class="muted small">Guest consent recorded ${fmtDate(g.id_consent_at)}</p>` : ''}` : html`<p class="muted">No ID documents yet.</p>`;
      })()}
      <details><summary>+ Add a document (PAN, passport…)</summary>
        <form method="post" action="/admin/guests/${g.id}/docs" enctype="multipart/form-data" class="form"><div class="fields">
          <label>Person<select name="member_id"><option value="">${g.name}</option>${members.map((m) => html`<option value="${m.id}">${m.name}</option>`)}</select></label>
          <label>Document${sel('doc_type', V.DOC_TYPES.map((t) => [t, t]), V.extraDocTypes(e)[0] || 'PAN')}</label>
          <label>Number<input name="number" autocomplete="off"></label>
          <label>Photo<input type="file" name="file" accept="image/*,application/pdf"></label></div>
          <button class="primary sm">Save securely</button></form></details>
      ${g.id_type || g.id_file || members.some((m) => m.id_file) ? html`<form method="post" action="/admin/guests/${g.id}/delete-id" data-confirm="Delete all ID data for this party?" class="top-gap"><button class="danger sm">Delete all IDs of this party</button></form>` : ''}
    </div>
    ${require('./wa').guestPanel(g, require('../whatsapp').eventWithOrg(e.id))}
    <div class="grid2">
      <div class="card"><h3>Timeline</h3>
        <form method="post" action="/caller/guest/${g.id}/note" class="form noteform">
          <input type="hidden" name="back" value="/admin/guests/${g.id}">
          <textarea name="note" rows="2" placeholder="Add a note (e.g. spoke to son, confirming by Friday)" required></textarea>
          <button class="sm">Add note</button></form>
        ${S.timeline(S.guestTimeline(g.id))}</div>
      <div><h3>Calls</h3>${S.callsTable(calls, (c) => `/admin/calls/${c.id}/recording`)}</div>
    </div>
    <form method="post" action="/admin/guests/${g.id}/delete" class="danger-zone" data-confirm="Delete ${g.name}?"><button class="danger">Delete guest</button></form>`));
});

r.post('/guests/:id', (req, res) => {
  const { g, e } = T.loadGuest(req, res, req.params.id);
  if (!g) return;
  const b = req.body, who = req.user.name;
  const owner = b.assigned_to ? T.eventTeam(e).find((u) => u.id === Number(b.assigned_to)) : null;
  const followUp = S.followUpToDb(b.follow_up_at);
  if ((owner?.id ?? null) !== g.assigned_to) S.logActivity(g.event_id, g.id, who, 'assign', owner ? `Assigned to ${owner.name}` : 'Unassigned');
  if (followUp && followUp !== g.follow_up_at) S.logActivity(g.event_id, g.id, who, 'followup', `Follow-up set for ${fmtDate(followUp)}`);

  const vals = F.parse(b, F.GUEST_FIELDS.map((f) => f.key));
  if (!vals.name) delete vals.name;
  if (vals.hotel_id && !db.prepare('SELECT 1 FROM hotels WHERE id = ? AND event_id = ?').get(vals.hotel_id, e.id)) vals.hotel_id = null;
  F.update(g.id, { ...vals, assigned_to: undefined });
  db.prepare('UPDATE guests SET assigned_to = ?, follow_up_at = ? WHERE id = ?').run(owner?.id ?? null, followUp, g.id);
  F.saveCustom(g.id, F.customFields(e.id), b);

  const fns = W.functionsOf(e.id);
  if (fns.length) {
    const before = W.guestFunctions(g.id);
    for (const f of fns) {
      if (!b[`fn_inv_${f.id}`]) { db.prepare('DELETE FROM guest_functions WHERE guest_id = ? AND function_id = ?').run(g.id, f.id); continue; }
      W.inviteGuest(g.id, [f.id]);
      const rsvp = b[`fn_rsvp_${f.id}`], pax = b[`fn_pax_${f.id}`] === '' ? null : Number(b[`fn_pax_${f.id}`]);
      W.setFunctionAnswer(g.id, f.id, rsvp, pax == null ? null : Math.min(g.max_pax, pax));
      if (before.get(f.id)?.rsvp !== rsvp && rsvp !== 'pending') S.logActivity(g.event_id, g.id, who, 'rsvp', `${f.name}: ${W.RSVP_LABEL[rsvp]}`);
    }
    W.syncOverall(g.id);
  } else {
    const status = S.STATUS_LABEL[b.rsvp_status] ? b.rsvp_status : g.rsvp_status;
    if (status !== g.rsvp_status) S.logActivity(g.event_id, g.id, who, 'rsvp', `RSVP changed to ${S.STATUS_LABEL[status]}`);
    db.prepare(`UPDATE guests SET rsvp_status = ?, pax = ?,
      responded_at = CASE WHEN ? != 'pending' AND responded_at IS NULL THEN datetime('now') ELSE responded_at END WHERE id = ?`)
      .run(status, b.pax === '' || b.pax == null ? null : Number(b.pax), status, g.id);
  }
  back(res, `/admin/guests/${g.id}`, 'Saved');
});

r.post('/guests/:id/delete-id', (req, res) => {
  const { g, e } = T.loadGuest(req, res, req.params.id);
  if (!g) return;
  S.removeUpload('ids', g.id_file);
  for (const m of W.membersOf(g.id)) S.removeUpload('ids', m.id_file);
  for (const d of V.docsOf(g.id)) V.removeFile(d.file);
  db.prepare('UPDATE guests SET id_type=NULL, id_number=NULL, id_file=NULL, id_consent_at=NULL WHERE id=?').run(g.id);
  db.prepare('UPDATE guest_members SET id_type=NULL, id_number=NULL, id_file=NULL WHERE guest_id=?').run(g.id);
  db.prepare('DELETE FROM id_documents WHERE guest_id=?').run(g.id);
  back(res, `/admin/guests/${g.id}`, 'ID data deleted');
});

r.post('/guests/:id/delete', (req, res) => {
  const { g, e } = T.loadGuest(req, res, req.params.id);
  if (!g) return;
  S.removeUpload('ids', g.id_file);
  for (const m of W.membersOf(g.id)) S.removeUpload('ids', m.id_file);
  for (const d of V.docsOf(g.id)) V.removeFile(d.file);
  db.prepare('DELETE FROM guests WHERE id = ?').run(g.id);
  back(res, `/admin/events/${g.event_id}`, `Deleted ${g.name}`);
});

r.get('/guests/:id/id-file', (req, res) => {
  const { g } = T.loadGuest(req, res, req.params.id);
  if (!g) return;
  S.logActivity(g.event_id, g.id, req.user.name, 'id_view', `Viewed ${g.id_type || 'ID'} of ${g.name}`);
  S.sendUpload(res, 'ids', g.id_file);
});

// A call is visible if its wedding is; unmatched (no wedding) recordings belong to Candid Dulhan.
function loadCall(req, res) {
  const c = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (c && (c.event_id ? T.canAccessEvent(req.user, T.getEvent(c.event_id)) : req.user.platform)) return c;
  res.status(404).send('Not found');
  return null;
}
r.get('/calls/:id/recording', (req, res) => {
  const c = loadCall(req, res);
  if (c) S.sendUpload(res, 'recordings', c.recording_file);
});

// ---- Team ----
r.get('/team', (req, res) => {
  const users = db.prepare('SELECT * FROM users WHERE org_id = ? ORDER BY active DESC, name').all(req.user.org_id);
  const roleSel = (v) => html`<select name="role"><option value="caller" ${v === 'caller' ? 'selected' : ''}>Caller</option><option value="admin" ${v === 'admin' ? 'selected' : ''}>Admin</option></select>`;
  res.send(page(req, 'Team', html`
    <p><a href="/admin">← Weddings</a></p><h1>Team</h1>
    <p class="muted">Each team member logs in with their own email/phone and password. <strong>Callers</strong> see only the caller console; <strong>admins</strong> manage weddings, guests and the team.</p>
    ${S.teamTable(S.teamStats(null, T.orgTeam(req.user.org_id)))}
    <h2>Accounts</h2>
    <div class="table-wrap"><table>
      <tr><th>Name</th><th>Login</th><th>Role</th><th>Status</th><th>Change</th></tr>
      ${users.map((u) => html`<tr class="${u.active ? '' : 'muted'}"><td><strong>${u.name}</strong></td><td>${u.login}</td><td>${u.role}</td>
        <td>${u.active ? 'Active' : 'Deactivated'}</td>
        <td><form method="post" action="/admin/team/${u.id}" class="inline-form">
          ${roleSel(u.role)}<input type="password" name="password" placeholder="New password" autocomplete="new-password" minlength="6">
          <label class="check inline-check"><input type="checkbox" name="active" value="1" ${u.active ? 'checked' : ''}> Active</label>
          <button class="sm">Save</button></form></td></tr>`)}
    </table></div>
    <details class="card" ${users.length ? '' : 'open'}><summary><strong>+ Add team member</strong></summary>
      <form method="post" action="/admin/team" class="form">
        <div class="row"><label>Name<input name="name" required></label><label>Login (email or phone)<input name="login" required autocomplete="off"></label></div>
        <div class="row"><label>Role${roleSel('caller')}</label><label>Password<input type="password" name="password" required minlength="6" autocomplete="new-password"></label></div>
        <button class="primary">Add</button>
      </form></details>`));
});

r.post('/team', (req, res) => {
  const b = req.body;
  if (!b.name?.trim() || !b.login?.trim() || (b.password || '').length < 6) return back(res, '/admin/team', 'Name, login and a 6+ character password are required');
  try {
    db.prepare('INSERT INTO users (name, login, role, pass_hash, org_id) VALUES (?,?,?,?,?)')
      .run(b.name.trim(), b.login.trim(), b.role === 'admin' ? 'admin' : 'caller', hashPassword(b.password), req.user.org_id);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) return back(res, '/admin/team', 'That login is already used');
    throw err;
  }
  back(res, '/admin/team', `Added ${b.name.trim()} — share their login and password with them`);
});

r.post('/team/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!u) return res.status(404).send('Not found');
  if (u.id === req.user.uid && (!req.body.active || req.body.role !== 'admin')) return back(res, '/admin/team', 'You can’t deactivate or demote yourself');
  const b = req.body;
  if (b.password && b.password.length < 6) return back(res, '/admin/team', 'Password must be at least 6 characters');
  db.prepare('UPDATE users SET role = ?, active = ?, pass_hash = COALESCE(?, pass_hash) WHERE id = ?')
    .run(b.role === 'admin' ? 'admin' : 'caller', b.active ? 1 : 0, b.password ? hashPassword(b.password) : null, u.id);
  back(res, '/admin/team', `Updated ${u.name}`);
});

// ---- Recordings uploaded from Android that didn't match a guest ----
const platformOnly = (req, res, next) => (req.user.platform ? next() : res.status(404).send('Not found'));

r.get('/unmatched', platformOnly, (req, res) => {
  const calls = db.prepare('SELECT * FROM calls WHERE event_id IS NULL ORDER BY called_at DESC').all();
  res.send(page(req, 'Unmatched recordings', html`
    <p><a href="/admin">← Weddings</a></p><h1>Unmatched recordings</h1>
    <p class="muted">These were uploaded from a phone but the number didn't match any guest. Add the guest (or fix their number) and click “Match again”, or delete.</p>
    ${calls.length ? html`<div class="table-wrap"><table><tr><th>When</th><th>Phone</th><th>By</th><th>Recording</th><th></th></tr>
      ${calls.map((c) => html`<tr><td>${fmtDate(c.called_at)}</td><td>${c.phone || '—'}</td><td>${c.caller || ''}</td>
        <td><audio controls preload="none" src="/admin/calls/${c.id}/recording"></audio></td>
        <td class="nowrap"><form method="post" action="/admin/calls/${c.id}/rematch" class="inline"><button class="btn sm">Match again</button></form>
          <form method="post" action="/admin/calls/${c.id}/delete" class="inline" data-confirm="Delete this recording?"><button class="danger sm">Delete</button></form></td></tr>`)}
    </table></div>` : html`<p class="muted">Nothing here 🎉</p>`}`));
});

r.post('/calls/:id/rematch', platformOnly, (req, res) => {
  const c = loadCall(req, res);
  if (!c) return;
  const g = require('./api').findGuestByPhone(c.phone);
  if (!g) return back(res, '/admin/unmatched', 'Still no guest with that number');
  db.prepare('UPDATE calls SET guest_id = ?, event_id = ? WHERE id = ?').run(g.id, g.event_id, c.id);
  back(res, '/admin/unmatched', `Matched to ${g.name}`);
});

r.post('/calls/:id/delete', (req, res) => {
  const c = loadCall(req, res);
  if (!c) return;
  S.removeUpload('recordings', c.recording_file);
  db.prepare('DELETE FROM calls WHERE id = ?').run(c.id);
  back(res, c.event_id ? `/admin/events/${c.event_id}` : '/admin/unmatched', 'Deleted');
});

// ---- Candid Dulhan's view of the whole platform: partner companies, adoption and the service pipeline ----
r.get('/platform', platformOnly, (req, res) => {
  const orgs = db.prepare(`SELECT o.*,
      (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id AND u.active = 1) users,
      (SELECT COUNT(*) FROM events e WHERE e.org_id = o.id) weddings,
      (SELECT COUNT(*) FROM guests g JOIN events e ON e.id = g.event_id WHERE e.org_id = o.id) guests,
      (SELECT COUNT(*) FROM events e WHERE e.org_id = o.id AND e.service_status = 'active') services,
      (SELECT MAX(a.created_at) FROM activities a JOIN events e ON e.id = a.event_id WHERE e.org_id = o.id) last_active
    FROM orgs o WHERE o.is_platform = 0 ORDER BY o.created_at DESC`).all();
  const pipeline = db.prepare(`SELECT e.*, o.name org_name, o.contact_name, o.phone org_phone,
      (SELECT COUNT(*) FROM guests g WHERE g.event_id = e.id) guests
    FROM events e JOIN orgs o ON o.id = e.org_id WHERE o.is_platform = 0 AND e.service_status IN ('requested', 'active')
    ORDER BY e.service_status = 'requested' DESC, e.service_updated_at DESC`).all();
  const tot = orgs.reduce((t, o) => ({ weddings: t.weddings + o.weddings, guests: t.guests + o.guests, services: t.services + o.services }),
    { weddings: 0, guests: 0, services: 0 });
  const requested = pipeline.filter((e) => e.service_status === 'requested').length;
  const staffPicker = T.orgTeam(db.platformOrgId);
  const stat = (v, l) => html`<div class="stat"><div class="stat-v">${v}</div><div class="stat-l">${l}</div></div>`;
  res.send(page(req, 'Platform', html`
    <p><a href="/admin">← Weddings</a></p><div class="head"><h1>Platform dashboard</h1><div class="actions"><a class="btn" href="/admin/whatsapp">💬 WhatsApp setup</a></div></div>
    <p class="muted">Event companies using the free software, and the weddings where they want your RSVP desk. Companies sign up at <code>/signup</code>.</p>
    <section class="stats">${stat(orgs.length, 'Partner companies')}${stat(tot.weddings, 'Their weddings')}${stat(tot.guests, 'Guests on platform')}
      ${stat(requested, 'Service requests')}${stat(tot.services, 'Active services')}</section>
    <h2>RSVP desk pipeline</h2>
    ${pipeline.length ? html`<div class="table-wrap"><table>
      <tr><th>Wedding</th><th>Company</th><th>Guests</th><th>Brief</th><th>Status</th><th></th></tr>
      ${pipeline.map((e) => html`<tr>
        <td><strong>${e.title}</strong><br><small class="muted">${[fmtDate(e.event_date), e.city].filter(Boolean).join(' · ')}</small></td>
        <td>${e.org_name}<br><small class="muted">${[e.contact_name, e.org_phone].filter(Boolean).join(' · ')}</small></td>
        <td>${e.guests}</td><td class="notes">${e.service_note || ''}</td>
        <td><span class="badge svc-${e.service_status}">${T.SERVICE_LABEL[e.service_status]}</span><br><small class="muted">${fmtDate(e.service_updated_at)}</small></td>
        <td class="nowrap">${e.service_status === 'requested' ? html`
          <form method="post" action="/admin/platform/events/${e.id}" class="accept-form">
            ${staffPicker.map((p) => html`<label class="check inline-check"><input type="checkbox" name="staff" value="${p.id}"> ${p.name}</label>`)}
            <button name="action" value="accept" class="primary sm">Accept</button></form>
          <form method="post" action="/admin/platform/events/${e.id}" class="inline" data-confirm="Decline this request?"><button name="action" value="decline" class="danger sm">Decline</button></form>`
          : html`<a class="btn sm" href="/admin/events/${e.id}">Open</a>`}</td>
      </tr>`)}</table></div>` : html`<p class="muted">No requests yet.</p>`}
    <h2>Partner companies</h2>
    ${orgs.length ? html`<div class="table-wrap"><table>
      <tr><th>Company</th><th>Contact</th><th>City</th><th>Team</th><th>Weddings</th><th>Guests</th><th>Using RSVP desk</th><th>Joined</th><th>Last active</th></tr>
      ${orgs.map((o) => html`<tr><td><strong>${o.name}</strong></td><td>${o.contact_name || ''}<br><small class="muted">${[o.phone, o.email].filter(Boolean).join(' · ')}</small></td>
        <td>${o.city || ''}</td><td>${o.users}</td><td>${o.weddings}</td><td>${o.guests}</td><td>${o.services}</td>
        <td>${fmtDate(o.created_at)}</td><td>${o.last_active ? fmtDate(o.last_active) : html`<span class="muted">—</span>`}</td></tr>`)}
    </table></div>` : html`<p class="muted">No companies have signed up yet. Share <code>${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}/signup</code> with event companies.</p>`}`));
});

const platformAdmin = (req, res, next) => (req.user.platform && req.user.role === 'admin' ? next() : res.status(404).send('Not found'));

r.post('/platform/events/:id/staff', platformAdmin, (req, res) => {
  const e = T.getEvent(req.params.id);
  if (!e || e.service_status !== 'active') return back(res, '/admin/platform', 'Service is not active');
  const before = new Set(T.eventStaff(e.id).map((x) => x.id));
  T.setEventStaff(e.id, [].concat(req.body.staff || []));
  const after = T.eventStaff(e.id);
  // Guests of removed staff go back to the unassigned pool.
  db.prepare(`UPDATE guests SET assigned_to = NULL WHERE event_id = ? AND assigned_to IN (SELECT id FROM users WHERE org_id = ?)
    AND assigned_to NOT IN (SELECT user_id FROM event_staff WHERE event_id = ?)`).run(e.id, db.platformOrgId, e.id);
  if (after.map((x) => x.id).join() !== [...before].sort((a, b) => a - b).join())
    S.logActivity(e.id, null, req.user.name, 'service', `Dedicated staff: ${after.map((x) => x.name).join(', ') || 'none'}`);
  back(res, `/admin/events/${e.id}`, 'Staff updated');
});

r.post('/platform/events/:id', platformAdmin, (req, res) => {
  const e = T.getEvent(req.params.id);
  if (!e || e.service_status !== 'requested') return back(res, '/admin/platform', 'That request is no longer pending');
  const accept = req.body.action === 'accept';
  db.prepare("UPDATE events SET service_status = ?, service_updated_at = datetime('now') WHERE id = ?").run(accept ? 'active' : 'declined', e.id);
  if (accept) T.setEventStaff(e.id, [].concat(req.body.staff || []));
  S.logActivity(e.id, null, req.user.name, 'service', accept ? 'Candid Dulhan RSVP desk accepted — service is active' : 'RSVP desk request declined');
  back(res, accept ? `/admin/events/${e.id}` : '/admin/platform', accept ? `Service active — ${e.title} is now in your partner weddings` : 'Declined');
});

module.exports = r;
