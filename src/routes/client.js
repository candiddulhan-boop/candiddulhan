// Read-only dashboard shared with the wedding client via an unguessable link.
const express = require('express');
const db = require('../db');
const layout = require('../layout');
const { html, maskId, fmtDate } = require('../util');
const { sign, safeEqual } = require('../auth');
const S = require('../shared');
const W = require('../wedding');
const T = require('../tenancy');

const r = express.Router({ mergeParams: true });

r.use((req, res, next) => {
  req.event = db.prepare('SELECT e.*, o.name org_name, o.is_platform FROM events e JOIN orgs o ON o.id = e.org_id WHERE e.client_token = ?').get(req.params.ctoken);
  if (!req.event) return res.status(404).send('Dashboard not found. Ask your planner for a fresh link.');
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

// Optional PIN: once entered, remembered on this device with a signed cookie.
const pinCookie = (e) => `cd_client_${e.id}`;
const pinValue = (e) => sign(`${e.client_token}:${e.client_pin}`);
const pinPage = (e, error) => layout({ title: e.title, nav: false, event: e, body: html`
  <form method="post" class="form card login">
    <p class="eyebrow">Guest dashboard</p><h1 class="couple">${e.title}</h1>
    ${error ? html`<div class="flash warn">${error}</div>` : ''}
    <label>PIN<input name="pin" inputmode="numeric" autocomplete="off" autofocus required></label>
    <button class="primary big">Open dashboard</button>
  </form>` });

r.post('/', (req, res) => {
  const e = req.event;
  if (!e.client_pin || !safeEqual(String(req.body.pin || '').trim(), e.client_pin)) return res.status(401).send(pinPage(e, 'Wrong PIN'));
  res.setHeader('Set-Cookie', `${pinCookie(e)}=${pinValue(e)}; Path=/c/${e.client_token}; HttpOnly; SameSite=Lax; Max-Age=${90 * 86400}`);
  res.redirect(`/c/${e.client_token}`);
});

r.use((req, res, next) => {
  const e = req.event;
  if (!e.client_pin) return next();
  const got = (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === pinCookie(e))?.[1];
  if (got && safeEqual(got, pinValue(e))) return next();
  res.status(401).send(pinPage(e));
});

const guestOf = (req) => db.prepare('SELECT * FROM guests WHERE id = ? AND event_id = ?').get(req.params.id, req.event.id);

r.get('/', (req, res) => {
  const e = req.event, base = `/c/${e.client_token}`;
  const filter = { status: req.query.status, side: req.query.side, q: req.query.q };
  const guests = S.listGuests(e.id, filter);
  const tab = ['calls', 'activity', 'rooming', 'transport'].includes(req.query.tab) ? req.query.tab : 'guests';
  const fns = W.functionsOf(e.id);
  const answers = W.guestFunctionMap(e.id);
  const memberCount = new Map(db.prepare(`SELECT m.guest_id, COUNT(*) n FROM guest_members m JOIN guests g ON g.id = m.guest_id
    WHERE g.event_id = ? GROUP BY m.guest_id`).all(e.id).map((r) => [r.guest_id, r.n]));
  const staff = e.service_status === 'active' ? T.eventStaff(e.id) : [];
  const t = (key, label) => html`<a class="${tab === key ? 'on' : ''}" href="${base}${key === 'guests' ? '' : `?tab=${key}`}">${label}</a>`;
  // Clients see guest-facing activity only (not the team's internal notes or assignments).
  const activity = tab === 'activity' ? db.prepare(`SELECT a.*, g.name guest_name FROM activities a JOIN guests g ON g.id = a.guest_id
    WHERE a.event_id = ? AND a.kind IN ('rsvp', 'id', 'invite') ORDER BY a.created_at DESC, a.id DESC LIMIT 200`).all(e.id) : [];
  res.send(layout({ title: e.title, nav: false, event: e, body: html`
    <div class="head"><div><p class="eyebrow">Guest dashboard${e.is_platform ? '' : ` · ${e.org_name}`}</p><h1 class="couple">${e.title}</h1>
      <p class="muted">${[fmtDate(e.event_date), e.venue, e.city].filter(Boolean).join(' · ')}</p></div>
      <div class="actions"><a class="btn" href="${base}/report.pdf">⬇ PDF report</a><a class="btn" href="${base}/report.xlsx">⬇ Excel</a></div></div>
    ${staff.length ? html`<p class="muted">Your guest managers: <strong>${staff.map((x) => x.name).join(', ')}</strong></p>` : ''}
    ${S.statCards(S.stats(e.id))}
    ${W.functionTable(e.id)}
    <nav class="tabs">${t('guests', 'Guests')}${t('activity', 'Latest updates')}${t('rooming', 'Rooming')}${t('transport', 'Arrivals')}${t('calls', 'Calls &amp; recordings')}</nav>
    ${tab === 'activity' ? html`<div class="card">${S.timeline(activity, { showGuest: true })}</div>`
    : tab === 'rooming' ? roomingTable(e) : tab === 'transport' ? arrivalsTable(e)
    : tab === 'calls' ? S.callsTable(S.eventCalls(e.id), (c) => `${base}/calls/${c.id}/recording`) : html`
      ${S.filterBar(e.id, filter)}
      <div class="table-wrap"><table class="guests">
        <tr><th>Guest</th><th>Side / group</th><th>RSVP</th><th>People</th><th>Arrival</th><th>Departure</th><th>Stay</th><th>Food</th><th>ID</th></tr>
        ${guests.map((g) => html`<tr>
          <td><strong>${g.name}</strong><br><small class="muted">${g.phone || ''}</small>${g.guest_notes ? html`<br><small class="quote">“${g.guest_notes}”</small>` : ''}</td>
          <td>${g.side || ''}<br><small class="muted">${g.group_name || ''}</small></td>
          <td>${S.badge(g.rsvp_status)}${fns.length ? html`<br>${W.functionChips(fns, answers.get(g.id))}` : ''}</td>
          <td>${g.rsvp_status === 'yes' ? g.pax ?? 1 : '–'} / ${g.max_pax}${memberCount.get(g.id) ? html`<br><small class="muted">${memberCount.get(g.id)} named</small>` : ''}</td>
          <td>${fmtDate(g.arrival_date)}${g.arrival_mode || g.arrival_details ? html`<br><small class="muted">${[g.arrival_time, g.arrival_mode, g.arrival_details].filter(Boolean).join(' · ')}</small>` : ''}</td>
          <td>${fmtDate(g.departure_date)}</td>
          <td>${g.needs_stay == null ? '' : g.needs_stay ? 'Yes' : 'No'}</td>
          <td>${g.dietary || ''}</td>
          <td>${g.id_file ? html`<a target="_blank" href="${base}/guests/${g.id}/id-file">${g.id_type || 'View'}</a><br><small class="muted">${maskId(g.id_number)}</small>` : g.rsvp_status === 'yes' && e.require_id ? html`<span class="muted">Pending</span>` : ''}</td>
        </tr>`)}
      </table></div>`}
    <p class="muted small center">This link is private — please don’t forward it.</p>` }));
});

function roomingTable(e) {
  const rows = db.prepare(`SELECT g.*, h.name hotel_name FROM guests g LEFT JOIN hotels h ON h.id = g.hotel_id
    WHERE g.event_id = ? AND g.rsvp_status IN ('yes','maybe') AND (g.needs_stay = 1 OR g.hotel_id IS NOT NULL)
    ORDER BY h.name IS NULL, h.name, g.room_no, g.name`).all(e.id);
  if (!rows.length) return html`<p class="muted">No stays planned yet.</p>`;
  return html`<div class="table-wrap"><table><tr><th>Hotel</th><th>Room</th><th>Guest</th><th>People</th><th>Check-in</th><th>Check-out</th></tr>
    ${rows.map((g) => html`<tr><td>${g.hotel_name || html`<span class="overdue">To be assigned</span>`}</td><td>${[g.room_type, g.room_no].filter(Boolean).join(' · ')}</td>
      <td><strong>${g.name}</strong></td><td>${g.pax ?? g.max_pax}</td><td>${fmtDate(g.check_in || g.arrival_date)}</td><td>${fmtDate(g.check_out || g.departure_date)}</td></tr>`)}
  </table></div>`;
}

function arrivalsTable(e) {
  const rows = db.prepare(`SELECT * FROM guests WHERE event_id = ? AND rsvp_status IN ('yes','maybe') AND arrival_date IS NOT NULL AND arrival_date != ''
    ORDER BY arrival_date, COALESCE(arrival_time, '99'), name`).all(e.id);
  if (!rows.length) return html`<p class="muted">No arrival details yet.</p>`;
  return html`<div class="table-wrap"><table><tr><th>Arrival</th><th>Guest</th><th>People</th><th>Travel</th><th>Pickup</th><th>Departure</th></tr>
    ${rows.map((g) => html`<tr><td><strong>${fmtDate(g.arrival_date)}</strong> ${g.arrival_time || ''}</td><td>${g.name}</td><td>${g.pax ?? g.max_pax}</td>
      <td>${[g.arrival_mode, g.arrival_details, g.arrival_point].filter(Boolean).join(' · ')}</td>
      <td>${g.pickup_required === 1 ? g.pickup_status || 'Pending' : g.pickup_required === 0 ? 'Not needed' : ''}</td>
      <td>${fmtDate(g.departure_date)} ${g.departure_time || ''}</td></tr>`)}
  </table></div>`;
}

r.get('/members/:mid/id-file', (req, res) => S.sendUpload(res, 'ids', db.prepare(`SELECT m.id_file FROM guest_members m JOIN guests g ON g.id = m.guest_id
  WHERE m.id = ? AND g.event_id = ?`).get(req.params.mid, req.event.id)?.id_file));

r.get('/export.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="guest-list.csv"');
  res.send('﻿' + S.guestsCsv(req.event.id, { withIdNumbers: true, forClient: true }));
});

r.get('/guests/:id/id-file', (req, res) => {
  const g = guestOf(req);
  if (g) S.logActivity(g.event_id, g.id, 'Client', 'id_view', `Viewed ${g.id_type || 'ID'} of ${g.name} (client dashboard)`);
  S.sendUpload(res, 'ids', g?.id_file);
});
r.get('/docs/:did/file', (req, res) => {
  const d = db.prepare('SELECT d.*, g.name, g.event_id FROM id_documents d JOIN guests g ON g.id = d.guest_id WHERE d.id = ? AND g.event_id = ?').get(req.params.did, req.event.id);
  if (d) S.logActivity(d.event_id, d.guest_id, 'Client', 'id_view', `Viewed ${d.doc_type} of ${d.name} (client dashboard)`);
  S.sendUpload(res, 'ids', d?.file);
});
r.get('/calls/:id/recording', (req, res) => S.sendUpload(res, 'recordings',
  db.prepare('SELECT recording_file FROM calls WHERE id = ? AND event_id = ?').get(req.params.id, req.event.id)?.recording_file));

module.exports = r;
