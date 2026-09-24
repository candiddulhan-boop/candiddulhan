const express = require('express');
const multer = require('multer');
const db = require('../db');
const layout = require('../layout');
const { requireRole } = require('../auth');
const { html, token, parseCsv, maskId, fmtDate } = require('../util');
const S = require('../shared');

const r = express.Router();
r.use(requireRole('admin'));

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const getEvent = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id);
const getGuest = (id) => db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
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
  <label class="check"><input type="checkbox" name="collect_travel" value="1" ${e.collect_travel ?? 1 ? 'checked' : ''}> Collect arrival, departure &amp; stay details</label>`;
}

const eventFields = (b) => [b.title?.trim(), b.client_name || null, b.client_phone || null, b.event_date || null,
  b.venue || null, b.city || null, b.invite_message || null, b.welcome_note || null, b.require_id ? 1 : 0, b.collect_travel ? 1 : 0];

// ---- Weddings list ----
r.get('/', (req, res) => {
  const events = db.prepare(`SELECT e.*, COUNT(g.id) guests, SUM(g.rsvp_status != 'pending') responded,
      SUM(g.rsvp_status = 'yes') yes FROM events e LEFT JOIN guests g ON g.event_id = e.id
    GROUP BY e.id ORDER BY e.event_date IS NULL, e.event_date`).all();
  const unmatched = db.prepare('SELECT COUNT(*) n FROM calls WHERE event_id IS NULL').get().n;
  res.send(page(req, 'Weddings', html`
    <div class="head"><h1>Weddings</h1></div>
    ${unmatched ? html`<p class="flash warn"><a href="/admin/unmatched">${unmatched} call recording${unmatched === 1 ? '' : 's'} could not be matched to a guest →</a></p>` : ''}
    ${events.length ? html`<div class="cards">${events.map((e) => html`
      <a class="card event-card" href="/admin/events/${e.id}">
        <h2>${e.title}</h2>
        <p class="muted">${[fmtDate(e.event_date), e.venue, e.city].filter(Boolean).join(' · ')}</p>
        <p>${e.guests || 0} guests · ${e.responded || 0} responded · <strong>${e.yes || 0} attending</strong></p>
      </a>`)}</div>` : html`<p class="muted">No weddings yet. Create your first one below.</p>`}
    <details class="card" ${events.length ? '' : 'open'}><summary><strong>+ New wedding</strong></summary>
      <form method="post" action="/admin/events" class="form">${eventForm()}<button class="primary">Create wedding</button></form>
    </details>`));
});

r.post('/events', (req, res) => {
  if (!req.body.title?.trim()) return back(res, '/admin', 'Title is required');
  const info = db.prepare(`INSERT INTO events (title, client_name, client_phone, event_date, venue, city, invite_message,
    welcome_note, require_id, collect_travel, client_token) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(...eventFields(req.body), token(18));
  back(res, `/admin/events/${info.lastInsertRowid}`, 'Wedding created. Add guests below.');
});

// ---- Wedding detail ----
r.get('/events/:id', (req, res) => {
  const e = getEvent(req.params.id);
  if (!e) return res.status(404).send('Not found');
  const filter = { status: req.query.status, side: req.query.side, q: req.query.q };
  const guests = S.listGuests(e.id, filter);
  res.send(page(req, e.title, html`
    <div class="head">
      <div><h1>${e.title}</h1><p class="muted">${[fmtDate(e.event_date), e.venue, e.city].filter(Boolean).join(' · ')}
        ${e.client_name ? html` · Client: ${e.client_name}` : ''}</p></div>
      <div class="actions">
        <a class="btn" href="/admin/events/${e.id}/settings">Settings</a>
        <a class="btn" href="/admin/events/${e.id}/export.csv">Export CSV</a>
        <a class="btn" href="/caller/${e.id}">Caller view</a>
      </div>
    </div>
    <div class="card share">
      <div><strong>Client dashboard link</strong> <span class="muted">— share with the couple/family. Read-only; shows IDs &amp; recordings.</span></div>
      <div class="copyrow"><input readonly value="${S.clientUrl(req, e)}"><button type="button" data-copy>Copy</button>
      <a class="btn" target="_blank" href="${S.clientUrl(req, e)}">Open</a></div>
    </div>
    ${S.statCards(S.stats(e.id))}

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
      <details class="card"><summary><strong>⇪ Import guests from CSV</strong></summary>
        <form method="post" action="/admin/events/${e.id}/import" enctype="multipart/form-data" class="form">
          <p class="muted">Columns (header row required): <code>name, phone, side, group, max_pax, email</code>. Export from Google Sheets / Excel as CSV. Guests with a phone already on the list are skipped.</p>
          <input type="file" name="file" accept=".csv,text/csv" required>
          <button class="primary">Import</button>
        </form>
      </details>
    </div>

    <h2>Guests <small class="muted">(${guests.length})</small></h2>
    ${S.filterBar(e.id, filter)}
    <div class="table-wrap"><table class="guests">
      <tr><th>Guest</th><th>Side / group</th><th>RSVP</th><th>People</th><th>Arrival</th><th>ID</th><th>Calls</th><th>Invite</th></tr>
      ${guests.map((g) => html`<tr>
        <td><a href="/admin/guests/${g.id}"><strong>${g.name}</strong></a><br><small class="muted">${g.phone || ''}</small></td>
        <td>${g.side || ''}<br><small class="muted">${g.group_name || ''}</small></td>
        <td>${S.badge(g.rsvp_status)}</td>
        <td>${g.rsvp_status === 'yes' ? g.pax ?? 1 : '–'} / ${g.max_pax}</td>
        <td>${fmtDate(g.arrival_date)}${g.arrival_mode ? html`<br><small class="muted">${g.arrival_mode}</small>` : ''}</td>
        <td>${g.id_file ? html`<a href="/admin/guests/${g.id}/id-file" target="_blank">${g.id_type || 'View'}</a>` : g.id_type ? g.id_type : '–'}</td>
        <td>${g.call_count || ''}${g.last_outcome ? html`<br><small class="muted">${S.OUTCOMES[g.last_outcome] || g.last_outcome}</small>` : ''}</td>
        <td class="nowrap">
          ${g.phone ? html`<a class="btn sm wa" target="_blank" href="/admin/guests/${g.id}/whatsapp">${g.invited_at ? 'Resend' : 'WhatsApp'}</a>` : ''}
          <button type="button" class="btn sm" data-copy="${S.inviteUrl(req, g)}">Link</button>
          ${g.invited_at ? html`<br><small class="muted">sent ${fmtDate(g.invited_at)}</small>` : ''}
        </td>
      </tr>`)}
    </table></div>

    <h2>Call log</h2>
    ${S.callsTable(S.eventCalls(e.id), (c) => `/admin/calls/${c.id}/recording`)}

    <form method="post" action="/admin/events/${e.id}/delete" class="danger-zone" data-confirm="Delete this wedding, all guests, IDs and recordings? This cannot be undone.">
      <button class="danger">Delete wedding</button>
    </form>`));
});

r.get('/events/:id/settings', (req, res) => {
  const e = getEvent(req.params.id);
  if (!e) return res.status(404).send('Not found');
  res.send(page(req, `Settings · ${e.title}`, html`
    <p><a href="/admin/events/${e.id}">← ${e.title}</a></p><h1>Wedding settings</h1>
    <form method="post" action="/admin/events/${e.id}/settings" class="form card">${eventForm(e)}
      <label class="check"><input type="checkbox" name="rotate_client_link" value="1"> Generate a new client dashboard link (the old link stops working)</label>
      <button class="primary">Save</button></form>`));
});

r.post('/events/:id/settings', (req, res) => {
  const e = getEvent(req.params.id);
  if (!e) return res.status(404).send('Not found');
  db.prepare(`UPDATE events SET title=?, client_name=?, client_phone=?, event_date=?, venue=?, city=?, invite_message=?,
    welcome_note=?, require_id=?, collect_travel=?, client_token=? WHERE id=?`)
    .run(...eventFields(req.body), req.body.rotate_client_link ? token(18) : e.client_token, e.id);
  back(res, `/admin/events/${e.id}`, 'Saved');
});

r.post('/events/:id/delete', (req, res) => {
  const e = getEvent(req.params.id);
  if (!e) return res.status(404).send('Not found');
  for (const g of db.prepare('SELECT id_file FROM guests WHERE event_id = ?').all(e.id)) S.removeUpload('ids', g.id_file);
  for (const c of db.prepare('SELECT recording_file FROM calls WHERE event_id = ?').all(e.id)) S.removeUpload('recordings', c.recording_file);
  db.prepare('DELETE FROM events WHERE id = ?').run(e.id);
  back(res, '/admin', `Deleted ${e.title}`);
});

r.get('/events/:id/export.csv', (req, res) => {
  const e = getEvent(req.params.id);
  if (!e) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="guests-${e.id}.csv"`);
  res.send('﻿' + S.guestsCsv(e.id, { withIdNumbers: true }));
});

// ---- Guests ----
const insertGuest = db.prepare(`INSERT INTO guests (event_id, name, phone, email, side, group_name, max_pax, token)
  VALUES (?,?,?,?,?,?,?,?)`);

r.post('/events/:id/guests', (req, res) => {
  const e = getEvent(req.params.id);
  if (!e || !req.body.name?.trim()) return back(res, `/admin/events/${req.params.id}`, 'Name is required');
  const b = req.body;
  insertGuest.run(e.id, b.name.trim(), b.phone?.trim() || null, b.email?.trim() || null, b.side || null,
    b.group_name?.trim() || null, Math.max(1, Number(b.max_pax) || 1), token());
  back(res, `/admin/events/${e.id}`, `Added ${b.name.trim()}`);
});

r.post('/events/:id/import', csvUpload.single('file'), (req, res) => {
  const e = getEvent(req.params.id);
  if (!e || !req.file) return back(res, `/admin/events/${req.params.id}`, 'Choose a CSV file');
  const rows = parseCsv(req.file.buffer.toString('utf8'));
  if (rows.length < 2) return back(res, `/admin/events/${e.id}`, 'CSV is empty');
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const ix = {
    name: col('name', 'guestname', 'fullname'), phone: col('phone', 'mobile', 'whatsapp', 'phonenumber', 'contact'),
    email: col('email'), side: col('side'), group: col('group', 'groupname', 'category', 'relation'),
    pax: col('maxpax', 'pax', 'people', 'count', 'guests', 'members'),
  };
  if (ix.name < 0) return back(res, `/admin/events/${e.id}`, 'CSV needs a "name" column');
  const existing = new Set(db.prepare('SELECT phone FROM guests WHERE event_id = ? AND phone IS NOT NULL').all(e.id)
    .map((g) => g.phone.replace(/\D/g, '').slice(-10)));
  let added = 0, skipped = 0;
  const get = (row, i) => (i >= 0 ? (row[i] || '').trim() : '');
  db.exec('BEGIN');
  try {
    for (const row of rows.slice(1)) {
      const name = get(row, ix.name), phone = get(row, ix.phone);
      const key = phone.replace(/\D/g, '').slice(-10);
      if (!name || (key && existing.has(key))) { skipped++; continue; }
      if (key) existing.add(key);
      const side = get(row, ix.side);
      insertGuest.run(e.id, name, phone || null, get(row, ix.email) || null,
        /^b/i.test(side) ? 'Bride' : /^g/i.test(side) ? 'Groom' : side || null,
        get(row, ix.group) || null, Math.max(1, parseInt(get(row, ix.pax), 10) || 1), token());
      added++;
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  back(res, `/admin/events/${e.id}`, `Imported ${added} guest${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} (blank or duplicate)` : ''}`);
});

r.get('/guests/:id/whatsapp', (req, res) => {
  const g = getGuest(req.params.id);
  if (!g?.phone) return res.status(404).send('Guest has no phone number');
  db.prepare("UPDATE guests SET invited_at = datetime('now') WHERE id = ?").run(g.id);
  res.redirect(S.waUrl(req, getEvent(g.event_id), g));
});

r.get('/guests/:id', (req, res) => {
  const g = getGuest(req.params.id);
  if (!g) return res.status(404).send('Not found');
  const e = getEvent(g.event_id);
  const calls = db.prepare('SELECT c.*, ? guest_name FROM calls c WHERE guest_id = ? ORDER BY called_at DESC').all(g.name, g.id);
  const sel = (name, opts, v) => html`<select name="${name}">${opts.map(([k, l]) => html`<option value="${k}" ${String(v ?? '') === String(k) ? 'selected' : ''}>${l}</option>`)}</select>`;
  res.send(page(req, g.name, html`
    <p><a href="/admin/events/${e.id}">← ${e.title}</a></p>
    <div class="head"><h1>${g.name} ${S.badge(g.rsvp_status)}</h1>
      <div class="actions">
        ${g.phone ? html`<a class="btn" href="tel:${g.phone}">Call</a><a class="btn wa" target="_blank" href="/admin/guests/${g.id}/whatsapp">WhatsApp invite</a>` : ''}
        <a class="btn" target="_blank" href="/i/${g.token}">Open RSVP page</a>
      </div></div>
    <form method="post" action="/admin/guests/${g.id}" class="form card">
      <h3>Contact</h3>
      <div class="row"><label>Name<input name="name" required value="${g.name}"></label><label>Phone<input name="phone" value="${g.phone || ''}"></label></div>
      <div class="row"><label>Side${sel('side', [['', ''], ['Bride', 'Bride'], ['Groom', 'Groom']], g.side)}</label>
        <label>Group<input name="group_name" value="${g.group_name || ''}"></label></div>
      <div class="row"><label>Invited for (people)<input type="number" min="1" name="max_pax" value="${g.max_pax}"></label><label>Email<input name="email" value="${g.email || ''}"></label></div>
      <h3>RSVP</h3>
      <div class="row"><label>Status${sel('rsvp_status', Object.entries(S.STATUS_LABEL), g.rsvp_status)}</label>
        <label>People attending<input type="number" min="0" name="pax" value="${g.pax ?? ''}"></label></div>
      <div class="row"><label>Arrival date<input type="date" name="arrival_date" value="${g.arrival_date || ''}"></label>
        <label>Arrival mode${sel('arrival_mode', [['', ''], ['Flight', 'Flight'], ['Train', 'Train'], ['Car', 'Car'], ['Bus', 'Bus'], ['Local', 'Local']], g.arrival_mode)}</label></div>
      <label>Arrival details<input name="arrival_details" value="${g.arrival_details || ''}" placeholder="6E 2134, lands 14:30"></label>
      <div class="row"><label>Departure date<input type="date" name="departure_date" value="${g.departure_date || ''}"></label>
        <label>Needs stay${sel('needs_stay', [['', ''], ['1', 'Yes'], ['0', 'No']], g.needs_stay)}</label></div>
      <label>Dietary<input name="dietary" value="${g.dietary || ''}"></label>
      <label>Guest's note<textarea name="guest_notes" rows="2">${g.guest_notes || ''}</textarea></label>
      <label>Internal notes (not visible to client)<textarea name="internal_notes" rows="2">${g.internal_notes || ''}</textarea></label>
      <button class="primary">Save guest</button>
    </form>
    <div class="card"><h3>Government ID</h3>
      ${g.id_type || g.id_file ? html`<p>${g.id_type || ''} ${g.id_number ? html`· <code>${g.id_number}</code>` : ''}
        ${g.id_consent_at ? html`<br><small class="muted">Consent given ${fmtDate(g.id_consent_at)}</small>` : ''}</p>
        ${g.id_file ? html`<p><a class="btn" target="_blank" href="/admin/guests/${g.id}/id-file">View ID document</a></p>` : ''}
        <form method="post" action="/admin/guests/${g.id}/delete-id" data-confirm="Delete this guest's ID data?"><button class="danger sm">Delete ID data</button></form>`
        : html`<p class="muted">Not submitted yet.</p>`}
    </div>
    <h2>Calls</h2>
    ${S.callsTable(calls, (c) => `/admin/calls/${c.id}/recording`)}
    <form method="post" action="/admin/guests/${g.id}/delete" class="danger-zone" data-confirm="Delete ${g.name}?"><button class="danger">Delete guest</button></form>`));
});

r.post('/guests/:id', (req, res) => {
  const g = getGuest(req.params.id);
  if (!g) return res.status(404).send('Not found');
  const b = req.body;
  const status = S.STATUS_LABEL[b.rsvp_status] ? b.rsvp_status : g.rsvp_status;
  db.prepare(`UPDATE guests SET name=?, phone=?, email=?, side=?, group_name=?, max_pax=?, rsvp_status=?, pax=?,
    arrival_date=?, arrival_mode=?, arrival_details=?, departure_date=?, needs_stay=?, dietary=?, guest_notes=?, internal_notes=?,
    responded_at = CASE WHEN ? != 'pending' AND responded_at IS NULL THEN datetime('now') ELSE responded_at END WHERE id=?`)
    .run(b.name?.trim() || g.name, b.phone || null, b.email || null, b.side || null, b.group_name || null, Math.max(1, Number(b.max_pax) || 1),
      status, b.pax === '' || b.pax == null ? null : Number(b.pax), b.arrival_date || null, b.arrival_mode || null, b.arrival_details || null,
      b.departure_date || null, b.needs_stay === '' || b.needs_stay == null ? null : Number(b.needs_stay), b.dietary || null,
      b.guest_notes || null, b.internal_notes || null, status, g.id);
  back(res, `/admin/guests/${g.id}`, 'Saved');
});

r.post('/guests/:id/delete-id', (req, res) => {
  const g = getGuest(req.params.id);
  if (!g) return res.status(404).send('Not found');
  S.removeUpload('ids', g.id_file);
  db.prepare('UPDATE guests SET id_type=NULL, id_number=NULL, id_file=NULL, id_consent_at=NULL WHERE id=?').run(g.id);
  back(res, `/admin/guests/${g.id}`, 'ID data deleted');
});

r.post('/guests/:id/delete', (req, res) => {
  const g = getGuest(req.params.id);
  if (!g) return res.status(404).send('Not found');
  S.removeUpload('ids', g.id_file);
  db.prepare('DELETE FROM guests WHERE id = ?').run(g.id);
  back(res, `/admin/events/${g.event_id}`, `Deleted ${g.name}`);
});

r.get('/guests/:id/id-file', (req, res) => S.sendUpload(res, 'ids', getGuest(req.params.id)?.id_file));
r.get('/calls/:id/recording', (req, res) =>
  S.sendUpload(res, 'recordings', db.prepare('SELECT recording_file FROM calls WHERE id = ?').get(req.params.id)?.recording_file));

// ---- Recordings uploaded from Android that didn't match a guest ----
r.get('/unmatched', (req, res) => {
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

r.post('/calls/:id/rematch', (req, res) => {
  const c = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  const g = c && require('./api').findGuestByPhone(c.phone);
  if (!g) return back(res, '/admin/unmatched', 'Still no guest with that number');
  db.prepare('UPDATE calls SET guest_id = ?, event_id = ? WHERE id = ?').run(g.id, g.event_id, c.id);
  back(res, '/admin/unmatched', `Matched to ${g.name}`);
});

r.post('/calls/:id/delete', (req, res) => {
  const c = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (c) { S.removeUpload('recordings', c.recording_file); db.prepare('DELETE FROM calls WHERE id = ?').run(c.id); }
  back(res, c?.event_id ? `/admin/events/${c.event_id}` : '/admin/unmatched', 'Deleted');
});

module.exports = r;
