// Wedding operations for the planner's team: functions, custom fields, rooming, transport, family members.
const express = require('express');
const db = require('../db');
const layout = require('../layout');
const { requireRole } = require('../auth');
const { html, fmtDate, toCsv, maskId } = require('../util');
const S = require('../shared');
const T = require('../tenancy');
const W = require('../wedding');
const F = require('../fields');
const V = require('../vault');

const r = express.Router();
r.use(requireRole('admin'));

const back = (res, url, msg) => res.redirect(`${url}${msg ? `${url.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}` : ''}`);
const page = (req, e, active, title, body) => layout({ title: `${title} · ${e.title}`, user: req.user, flash: req.query.msg, body: html`
  <div class="head"><div><h1>${e.title}</h1><p class="muted">${[fmtDate(e.event_date), e.venue, e.city].filter(Boolean).join(' · ')}</p></div></div>
  ${W.eventNav(e, active, { owner: T.ownsEvent(req.user, e) })}
  ${body}` });
const csv = (res, name, rows) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send('﻿' + toCsv(rows));
};
const clean = (v, n = 200) => String(v ?? '').trim().slice(0, n) || null;

// ---------------- Functions ----------------
r.get('/events/:id/functions', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  const fns = W.functionStats(e.id);
  const form = (f = {}) => html`
    <div class="fields">
      <label>Name<input name="name" required value="${f.name || ''}" placeholder="Sangeet"></label>
      <label>Date<input type="date" name="date" value="${f.date || ''}"></label>
      <label>Time<input type="time" name="time" value="${f.time || ''}"></label>
      <label>Venue<input name="venue" value="${f.venue || ''}"></label>
      <label>Dress code<input name="dress_code" value="${f.dress_code || ''}" placeholder="Pastels"></label>
      <label>Order<input type="number" name="sort" value="${f.sort ?? ''}"></label>
      <label class="wide">Notes<input name="notes" value="${f.notes || ''}"></label>
    </div>`;
  res.send(page(req, e, 'functions', 'Functions', html`
    <p class="muted">Each guest can be invited to some or all functions and answers separately for each. Headcounts below update live.</p>
    ${fns.length ? '' : html`<form method="post" action="/admin/events/${e.id}/functions/defaults" class="card">
      <strong>Quick start:</strong> add ${W.DEFAULT_FUNCTIONS.join(', ')} and invite all guests to each.
      <button class="primary sm">Add standard functions</button></form>`}
    ${W.functionTable(e.id)}
    ${fns.map((f) => html`<details class="card"><summary><strong>${f.name}</strong>
        <span class="muted">${[fmtDate(f.date), f.time, f.venue].filter(Boolean).join(' · ')} — ${f.people} people attending</span></summary>
      <form method="post" action="/admin/functions/${f.id}" class="form">${form(f)}
        <div class="actions"><button class="primary" name="action" value="save">Save</button>
          <button name="action" value="invite_all">Invite all guests</button>
          <button name="action" value="delete" class="danger" data-confirm-click="Delete ${f.name} and its RSVPs?">Delete</button></div>
      </form></details>`)}
    <details class="card" ${fns.length ? '' : 'open'}><summary><strong>+ Add function</strong></summary>
      <form method="post" action="/admin/events/${e.id}/functions" class="form">${form()}
        <label class="check"><input type="checkbox" name="invite_all" value="1" checked> Invite all current guests</label>
        <button class="primary">Add function</button></form></details>`));
});

const fnFields = (b) => [clean(b.name, 80), clean(b.date, 10), clean(b.time, 5), clean(b.venue), clean(b.dress_code), clean(b.notes, 500), Number(b.sort) || 0];
const inviteAll = (eventId, fnId) => db.prepare('INSERT OR IGNORE INTO guest_functions (guest_id, function_id) SELECT id, ? FROM guests WHERE event_id = ?').run(fnId, eventId).changes;

r.post('/events/:id/functions', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  if (!clean(req.body.name)) return back(res, `/admin/events/${e.id}/functions`, 'Name is required');
  const id = Number(db.prepare('INSERT INTO functions (name, date, time, venue, dress_code, notes, sort, event_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(...fnFields(req.body), e.id).lastInsertRowid);
  if (req.body.invite_all) inviteAll(e.id, id);
  back(res, `/admin/events/${e.id}/functions`, `Added ${req.body.name}`);
});

r.post('/events/:id/functions/defaults', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  W.DEFAULT_FUNCTIONS.forEach((name, i) => {
    const id = Number(db.prepare('INSERT INTO functions (event_id, name, sort) VALUES (?,?,?)').run(e.id, name, i + 1).lastInsertRowid);
    inviteAll(e.id, id);
  });
  back(res, `/admin/events/${e.id}/functions`, 'Added standard functions — set their dates and venues below');
});

r.post('/functions/:fid', (req, res) => {
  const f = db.prepare('SELECT * FROM functions WHERE id = ?').get(req.params.fid);
  const e = f && T.loadEvent(req, res, f.event_id);
  if (!f) return res.status(404).send('Not found');
  if (!e) return;
  const url = `/admin/events/${e.id}/functions`;
  if (req.body.action === 'delete') {
    db.prepare('DELETE FROM functions WHERE id = ?').run(f.id);
    for (const g of db.prepare('SELECT id FROM guests WHERE event_id = ?').all(e.id)) W.syncOverall(g.id);
    return back(res, url, `Deleted ${f.name}`);
  }
  if (req.body.action === 'invite_all') return back(res, url, `Invited ${inviteAll(e.id, f.id)} more guests to ${f.name}`);
  if (!clean(req.body.name)) return back(res, url, 'Name is required');
  db.prepare('UPDATE functions SET name=?, date=?, time=?, venue=?, dress_code=?, notes=?, sort=? WHERE id=?').run(...fnFields(req.body), f.id);
  back(res, url, 'Saved');
});

// ---------------- Custom fields ----------------
r.get('/events/:id/fields', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  const cfs = F.customFields(e.id);
  const types = [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['select', 'Dropdown'], ['yesno', 'Yes / No']];
  res.send(page(req, e, 'fields', 'Custom fields', html`
    <p class="muted">Add anything extra you track for this wedding — T-shirt size, dance performance, gift list, invitation card sent… Tick “Ask guests” to show it on the RSVP page.</p>
    <p class="muted small">Built-in fields already cover contact, relation, party size, arrival, departure, stay, food, special needs and notes (${F.GUEST_FIELDS.length} fields).</p>
    ${cfs.length ? html`<div class="table-wrap"><table><tr><th>Field</th><th>Type</th><th>Options</th><th>Ask guests</th><th></th></tr>
      ${cfs.map((cf) => html`<tr><td><strong>${cf.label}</strong></td><td>${types.find(([k]) => k === cf.type)?.[1]}</td><td>${cf.options || ''}</td>
        <td>${cf.on_rsvp ? 'Yes' : 'No'}</td>
        <td><form method="post" action="/admin/fields/${cf.id}/delete" class="inline" data-confirm="Delete ${cf.label} and its values?"><button class="danger sm">Delete</button></form></td></tr>`)}
    </table></div>` : ''}
    <form method="post" action="/admin/events/${e.id}/fields" class="form card"><h3>Add field</h3>
      <div class="fields">
        <label>Label<input name="label" required placeholder="Performing at Sangeet?"></label>
        <label>Type<select name="type">${types.map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select></label>
        <label class="wide">Options <small>(for dropdown, comma separated)</small><input name="options" placeholder="S, M, L, XL"></label>
      </div>
      <label class="check"><input type="checkbox" name="on_rsvp" value="1"> Ask guests on the RSVP page</label>
      <button class="primary">Add field</button></form>`));
});

r.post('/events/:id/fields', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  const b = req.body;
  if (!clean(b.label)) return back(res, `/admin/events/${e.id}/fields`, 'Label is required');
  db.prepare('INSERT INTO custom_fields (event_id, label, type, options, on_rsvp, sort) VALUES (?,?,?,?,?,?)')
    .run(e.id, clean(b.label, 80), ['text', 'number', 'date', 'select', 'yesno'].includes(b.type) ? b.type : 'text', clean(b.options, 500),
      b.on_rsvp ? 1 : 0, F.customFields(e.id).length);
  back(res, `/admin/events/${e.id}/fields`, `Added ${b.label}`);
});

r.post('/fields/:fid/delete', (req, res) => {
  const cf = db.prepare('SELECT * FROM custom_fields WHERE id = ?').get(req.params.fid);
  if (!cf) return res.status(404).send('Not found');
  const e = T.loadEvent(req, res, cf.event_id);
  if (!e) return;
  db.prepare('DELETE FROM custom_fields WHERE id = ?').run(cf.id);
  back(res, `/admin/events/${e.id}/fields`, `Deleted ${cf.label}`);
});

// ---------------- Rooming ----------------
const stayGuests = (eventId) => db.prepare(`SELECT g.*, h.name hotel_name,
    (SELECT COUNT(*) FROM guest_members m WHERE m.guest_id = g.id) members
  FROM guests g LEFT JOIN hotels h ON h.id = g.hotel_id
  WHERE g.event_id = ? AND g.rsvp_status IN ('yes', 'maybe') AND (g.needs_stay = 1 OR g.hotel_id IS NOT NULL)
  ORDER BY h.name IS NULL, h.name, g.room_no, g.name`).all(eventId);

r.get('/events/:id/rooming', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  const hotels = db.prepare(`SELECT h.*, COUNT(g.id) assigned, COUNT(DISTINCT NULLIF(g.room_no, '')) rooms
    FROM hotels h LEFT JOIN guests g ON g.hotel_id = h.id AND g.rsvp_status IN ('yes','maybe') WHERE h.event_id = ? GROUP BY h.id ORDER BY h.name`).all(e.id);
  const guests = stayGuests(e.id);
  const unassigned = guests.filter((g) => !g.hotel_id).length;
  const roomTypes = F.FIELD.room_type.options;
  res.send(page(req, e, 'rooming', 'Rooming', html`
    <div class="head"><p class="muted">Attending guests who need a stay. Assign hotel and room here; the rooming list exports for the hotel.</p>
      <div class="actions"><a class="btn" href="/admin/events/${e.id}/rooming.csv">Download rooming list</a></div></div>
    <div class="cards">${hotels.map((h) => html`<div class="card"><h3>${h.name}</h3>
      <p class="muted small">${[h.address, h.contact].filter(Boolean).join(' · ')}</p>
      <p><strong>${h.assigned}</strong> parties · ${h.rooms} rooms used${h.rooms_blocked ? html` of <strong>${h.rooms_blocked}</strong> blocked` : ''}</p>
      <form method="post" action="/admin/hotels/${h.id}/delete" data-confirm="Remove ${h.name}? Guests assigned to it become unassigned."><button class="danger sm">Remove</button></form></div>`)}
      <details class="card"><summary><strong>+ Add hotel</strong></summary>
        <form method="post" action="/admin/events/${e.id}/hotels" class="form">
          <label>Name<input name="name" required></label><label>Address<input name="address"></label>
          <label>Contact<input name="contact" placeholder="Front office 0294…"></label>
          <label>Rooms blocked<input type="number" name="rooms_blocked" min="0"></label>
          <button class="primary">Add hotel</button></form></details>
    </div>
    ${unassigned ? html`<p class="flash warn">${unassigned} part${unassigned === 1 ? 'y needs' : 'ies need'} a hotel.</p>` : ''}
    <div class="table-wrap"><table>
      <tr><th>Guest</th><th>People</th><th>Stay dates</th><th>Hotel · room type · room no. · check-in · check-out</th></tr>
      ${guests.map((g) => html`<tr>
        <td><a href="/admin/guests/${g.id}"><strong>${g.name}</strong></a> ${S.badge(g.rsvp_status)}<br>
          <small class="muted">${[g.side, g.group_name, g.special_needs].filter(Boolean).join(' · ')}</small></td>
        <td>${g.pax ?? g.max_pax}${g.kids ? html` <small class="muted">(${g.kids} kids)</small>` : ''}</td>
        <td>${fmtDate(g.arrival_date)} → ${fmtDate(g.departure_date)}</td>
        <td><form method="post" action="/admin/guests/${g.id}/room" class="inline-form">
          <select name="hotel_id"><option value="">Hotel…</option>${hotels.map((h) => html`<option value="${h.id}" ${g.hotel_id === h.id ? 'selected' : ''}>${h.name}</option>`)}</select>
          <select name="room_type">${roomTypes.map(([k, l]) => html`<option value="${k}" ${g.room_type === k ? 'selected' : ''}>${l || 'Type…'}</option>`)}</select>
          <input name="room_no" value="${g.room_no || ''}" placeholder="Room" size="5">
          <input type="date" name="check_in" value="${g.check_in || g.arrival_date || ''}">
          <input type="date" name="check_out" value="${g.check_out || g.departure_date || ''}">
          <button class="sm">Save</button></form></td>
      </tr>`)}
    </table></div>
    ${guests.length ? '' : html`<p class="muted">No attending guests need a stay yet.</p>`}`));
});

r.post('/events/:id/hotels', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  const b = req.body;
  if (!clean(b.name)) return back(res, `/admin/events/${e.id}/rooming`, 'Hotel name is required');
  db.prepare('INSERT INTO hotels (event_id, name, address, contact, rooms_blocked) VALUES (?,?,?,?,?)')
    .run(e.id, clean(b.name, 120), clean(b.address), clean(b.contact), b.rooms_blocked ? Number(b.rooms_blocked) : null);
  back(res, `/admin/events/${e.id}/rooming`, `Added ${b.name}`);
});

r.post('/hotels/:hid/delete', (req, res) => {
  const h = db.prepare('SELECT * FROM hotels WHERE id = ?').get(req.params.hid);
  if (!h) return res.status(404).send('Not found');
  const e = T.loadEvent(req, res, h.event_id);
  if (!e) return;
  db.prepare('UPDATE guests SET hotel_id = NULL WHERE hotel_id = ?').run(h.id);
  db.prepare('DELETE FROM hotels WHERE id = ?').run(h.id);
  back(res, `/admin/events/${e.id}/rooming`, `Removed ${h.name}`);
});

r.post('/guests/:id/room', (req, res) => {
  const { g, e } = T.loadGuest(req, res, req.params.id);
  if (!g) return;
  const vals = F.parse(req.body, ['hotel_id', 'room_type', 'room_no', 'check_in', 'check_out']);
  if (vals.hotel_id && !db.prepare('SELECT 1 FROM hotels WHERE id = ? AND event_id = ?').get(vals.hotel_id, e.id)) vals.hotel_id = null;
  F.update(g.id, vals);
  back(res, `/admin/events/${e.id}/rooming`, `Saved room for ${g.name}`);
});

r.get('/events/:id/rooming.csv', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  const rows = stayGuests(e.id);
  const out = [['Hotel', 'Room type', 'Room no.', 'Guest', 'Phone', 'People', 'Kids', 'Family members', 'Check-in', 'Check-out', 'Arrival', 'Sharing with', 'Special needs', 'ID on file']];
  for (const g of rows) {
    const members = W.membersOf(g.id);
    out.push([g.hotel_name || 'UNASSIGNED', g.room_type, g.room_no, [g.salutation, g.name].filter(Boolean).join(' '), g.phone, g.pax ?? g.max_pax, g.kids,
      members.map((m) => m.name).join('; '), g.check_in || g.arrival_date, g.check_out || g.departure_date,
      [g.arrival_date, g.arrival_time, g.arrival_mode, g.arrival_details].filter(Boolean).join(' '), g.sharing_with, g.special_needs,
      [g.id_type && `${g.id_type} ${maskId(g.id_number)}`, ...members.filter((m) => m.id_type).map((m) => `${m.name}: ${m.id_type}`)].filter(Boolean).join('; ')]);
  }
  csv(res, `rooming-${e.id}.csv`, out);
});

// ---------------- Transport ----------------
const travelGuests = (eventId, dir) => db.prepare(`SELECT g.*, h.name hotel_name FROM guests g LEFT JOIN hotels h ON h.id = g.hotel_id
  WHERE g.event_id = ? AND g.rsvp_status IN ('yes', 'maybe') AND g.${dir}_date IS NOT NULL AND g.${dir}_date != ''
  ORDER BY g.${dir}_date, COALESCE(g.${dir}_time, '99'), g.name`).all(eventId);

r.get('/events/:id/transport', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  const dir = req.query.dir === 'departure' ? 'departure' : 'arrival';
  const p = dir === 'arrival' ? 'pickup' : 'drop';
  const rows = travelGuests(e.id, dir);
  const byDate = new Map();
  for (const g of rows) (byDate.get(g[`${dir}_date`]) || byDate.set(g[`${dir}_date`], []).get(g[`${dir}_date`])).push(g);
  const needed = rows.filter((g) => g[`${p}_required`] === 1);
  const pending = needed.filter((g) => g[`${p}_status`] !== 'Done' && !g[`${p}_vehicle`]).length;
  const num = dir === 'arrival' ? 'arrival_details' : 'departure_number';
  const point = `${dir}_point`;
  res.send(page(req, e, 'transport', 'Transport', html`
    <div class="head"><nav class="tabs pills-nav">
        <a class="${dir === 'arrival' ? 'on' : ''}" href="?dir=arrival">Arrivals &amp; pickups</a>
        <a class="${dir === 'departure' ? 'on' : ''}" href="?dir=departure">Departures &amp; drops</a></nav>
      <div class="actions"><a class="btn" href="/admin/events/${e.id}/transport.csv?dir=${dir}">Download ${dir === 'arrival' ? 'pickup' : 'drop'} sheet</a></div></div>
    <p class="muted">${rows.length} parties · ${needed.length} need a ${p}${pending ? html` · <span class="overdue">${pending} without a vehicle yet</span>` : ''}</p>
    ${[...byDate.entries()].map(([date, gs]) => html`<h3>${fmtDate(date)} <small class="muted">(${gs.reduce((n, g) => n + (g.pax ?? g.max_pax), 0)} people)</small></h3>
      <div class="table-wrap"><table>
        <tr><th>Time</th><th>Guest</th><th>People</th><th>Travel</th><th>${dir === 'arrival' ? 'Going to' : 'From'}</th><th>${p === 'pickup' ? 'Pickup' : 'Drop'}: status · vehicle / driver</th></tr>
        ${gs.map((g) => html`<tr class="${g[`${p}_required`] === 1 && !g[`${p}_vehicle`] ? 'row-warn' : ''}">
          <td><strong>${g[`${dir}_time`] || '—'}</strong></td>
          <td><a href="/admin/guests/${g.id}">${g.name}</a><br><small class="muted">${g.phone || ''}</small></td>
          <td>${g.pax ?? g.max_pax}</td>
          <td>${[g[`${dir}_mode`], g[num]].filter(Boolean).join(' ')}<br><small class="muted">${g[point] || ''}${dir === 'arrival' && g.arrival_from ? ` · from ${g.arrival_from}` : ''}</small></td>
          <td>${g.hotel_name || html`<span class="muted">—</span>`}</td>
          <td>${g[`${p}_required`] === 0 ? html`<span class="muted">Not needed</span>` : html`<form method="post" action="/admin/guests/${g.id}/transport" class="inline-form">
            <input type="hidden" name="dir" value="${dir}">
            <select name="${p}_status">${['', 'Pending', 'Assigned', 'Done'].map((s) => html`<option ${g[`${p}_status`] === s ? 'selected' : ''}>${s}</option>`)}</select>
            <input name="${p}_vehicle" value="${g[`${p}_vehicle`] || ''}" placeholder="Vehicle · driver · phone">
            <button class="sm">Save</button></form>`}</td>
        </tr>`)}
      </table></div>`)}
    ${rows.length ? '' : html`<p class="muted">No ${dir} details yet. They appear here as guests RSVP with travel details.</p>`}`));
});

r.post('/guests/:id/transport', (req, res) => {
  const { g, e } = T.loadGuest(req, res, req.params.id);
  if (!g) return;
  const p = req.body.dir === 'departure' ? 'drop' : 'pickup';
  F.update(g.id, { ...F.parse(req.body, [`${p}_status`, `${p}_vehicle`]), [`${p}_required`]: 1 });
  back(res, `/admin/events/${e.id}/transport?dir=${req.body.dir === 'departure' ? 'departure' : 'arrival'}`, `Saved ${p} for ${g.name}`);
});

r.get('/events/:id/transport.csv', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  const dir = req.query.dir === 'departure' ? 'departure' : 'arrival';
  const p = dir === 'arrival' ? 'pickup' : 'drop';
  const out = [['Date', 'Time', 'Guest', 'Phone', 'People', 'Mode', 'Flight/train', dir === 'arrival' ? 'Arriving at' : 'Leaving from', 'Hotel', `${p} needed`, `${p} status`, 'Vehicle / driver', 'Special needs']];
  for (const g of travelGuests(e.id, dir)) {
    out.push([g[`${dir}_date`], g[`${dir}_time`], g.name, g.phone, g.pax ?? g.max_pax, g[`${dir}_mode`], dir === 'arrival' ? g.arrival_details : g.departure_number,
      g[`${dir}_point`], g.hotel_name, g[`${p}_required`] == null ? '' : g[`${p}_required`] ? 'Yes' : 'No', g[`${p}_status`], g[`${p}_vehicle`], g.special_needs]);
  }
  csv(res, `${p}s-${e.id}.csv`, out);
});

// ---------------- Family members ----------------
function memberFields(b) {
  const id = V.checkNumber(b.id_type, b.id_number);
  if (id.error) throw Object.assign(new Error(id.error), { user: true });
  return [clean(b.name, 80), clean(b.relation, 60), ['Adult', 'Child', 'Senior'].includes(b.age_group) ? b.age_group : null,
    clean(b.gender, 10), clean(b.phone, 20), clean(b.dietary, 40), clean(b.id_type, 30), id.value];
}

r.post('/guests/:id/members', S.idUpload.single('id_file'), (req, res) => {
  const { g } = T.loadGuest(req, res, req.params.id);
  if (!g) { S.removeUpload('ids', req.file?.filename); return; }
  if (!clean(req.body.name)) { S.removeUpload('ids', req.file?.filename); return back(res, `/admin/guests/${g.id}`, 'Member name is required'); }
  let vals;
  try { vals = memberFields(req.body); } catch (err) { S.removeUpload('ids', req.file?.filename); return back(res, `/admin/guests/${g.id}#members`, err.message); }
  db.prepare(`INSERT INTO guest_members (name, relation, age_group, gender, phone, dietary, id_type, id_number, id_file, guest_id, sort)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(...vals, req.file?.filename || null, g.id, W.membersOf(g.id).length);
  S.logActivity(g.event_id, g.id, req.user.name, 'note', `Family member added: ${req.body.name}`);
  back(res, `/admin/guests/${g.id}#members`, `Added ${req.body.name}`);
});

function loadMember(req, res) {
  const m = db.prepare('SELECT * FROM guest_members WHERE id = ?').get(req.params.mid);
  if (!m) { res.status(404).send('Not found'); return {}; }
  const { g } = T.loadGuest(req, res, m.guest_id);
  return g ? { m, g } : {};
}

r.post('/members/:mid', S.idUpload.single('id_file'), (req, res) => {
  const { m, g } = loadMember(req, res);
  if (!m) { S.removeUpload('ids', req.file?.filename); return; }
  if (req.body.action === 'delete') {
    S.removeUpload('ids', m.id_file);
    V.docsOf(g.id).filter((d) => d.member_id === m.id).forEach((d) => V.removeFile(d.file));
    db.prepare('DELETE FROM guest_members WHERE id = ?').run(m.id);
    return back(res, `/admin/guests/${g.id}#members`, `Removed ${m.name}`);
  }
  let vals;
  try { vals = memberFields(req.body); } catch (err) { S.removeUpload('ids', req.file?.filename); return back(res, `/admin/guests/${g.id}#members`, err.message); }
  if (req.file) S.removeUpload('ids', m.id_file);
  db.prepare(`UPDATE guest_members SET name = COALESCE(?, name), relation=?, age_group=?, gender=?, phone=?, dietary=?, id_type=?,
    id_number = COALESCE(?, id_number), id_file = COALESCE(?, id_file) WHERE id = ?`).run(...vals, req.file?.filename || null, m.id);
  back(res, `/admin/guests/${g.id}#members`, `Saved ${m.name}`);
});

r.get('/members/:mid/id-file', (req, res) => {
  const { m, g } = loadMember(req, res);
  if (!m) return;
  S.logActivity(g.event_id, g.id, req.user.name, 'id_view', `Viewed ${m.id_type || 'ID'} of ${m.name}`);
  S.sendUpload(res, 'ids', m.id_file);
});

// ---------------- Extra ID documents (PAN, passport …) ----------------
r.post('/guests/:id/docs', S.idUpload.single('file'), (req, res) => {
  const { g } = T.loadGuest(req, res, req.params.id);
  if (!g) { S.removeUpload('ids', req.file?.filename); return; }
  const b = req.body;
  const url = `/admin/guests/${g.id}#documents`;
  const memberId = b.member_id ? Number(b.member_id) : null;
  if (memberId && !W.membersOf(g.id).some((m) => m.id === memberId)) { S.removeUpload('ids', req.file?.filename); return back(res, url, 'Unknown family member'); }
  if (!V.DOC_TYPES.includes(b.doc_type)) { S.removeUpload('ids', req.file?.filename); return back(res, url, 'Choose a document type'); }
  const num = V.checkNumber(b.doc_type, b.number);
  if (num.error) { S.removeUpload('ids', req.file?.filename); return back(res, url, num.error); }
  if (!num.value && !req.file) return back(res, url, 'Add a number or a photo');
  V.saveDoc(g.id, memberId, b.doc_type, { number: num.value, file: req.file?.filename });
  S.logActivity(g.event_id, g.id, req.user.name, 'id', `${b.doc_type} added${memberId ? ` for ${W.membersOf(g.id).find((m) => m.id === memberId).name}` : ''}`);
  back(res, url, `${b.doc_type} saved (encrypted)`);
});

function loadDoc(req, res) {
  const d = db.prepare('SELECT * FROM id_documents WHERE id = ?').get(req.params.did);
  if (!d) { res.status(404).send('Not found'); return {}; }
  const { g } = T.loadGuest(req, res, d.guest_id);
  return g ? { d, g } : {};
}
r.get('/docs/:did/file', (req, res) => {
  const { d, g } = loadDoc(req, res);
  if (!d) return;
  const who = d.member_id ? db.prepare('SELECT name FROM guest_members WHERE id = ?').get(d.member_id)?.name : g.name;
  S.logActivity(g.event_id, g.id, req.user.name, 'id_view', `Viewed ${d.doc_type} of ${who}`);
  S.sendUpload(res, 'ids', d.file);
});
r.post('/docs/:did/delete', (req, res) => {
  const { d, g } = loadDoc(req, res);
  if (!d) return;
  V.removeFile(d.file);
  db.prepare('DELETE FROM id_documents WHERE id = ?').run(d.id);
  S.logActivity(g.event_id, g.id, req.user.name, 'id', `${d.doc_type} deleted`);
  back(res, `/admin/guests/${g.id}#documents`, `${d.doc_type} deleted`);
});

r.post('/events/:id/purge-ids', (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  if (!T.ownsEvent(req.user, e)) return back(res, `/admin/events/${e.id}`, 'Only the company that owns this wedding can do that');
  const n = V.purgeEvent(e.id);
  S.logActivity(e.id, null, req.user.name, 'id', `All ID documents deleted (${n} files)`);
  back(res, `/admin/events/${e.id}/settings`, `Deleted ${n} ID files and all ID numbers for this wedding`);
});

module.exports = r;
