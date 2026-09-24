// Read-only dashboard shared with the wedding client via an unguessable link.
const express = require('express');
const db = require('../db');
const layout = require('../layout');
const { html, maskId, fmtDate } = require('../util');
const { sign, safeEqual } = require('../auth');
const S = require('../shared');

const r = express.Router({ mergeParams: true });

r.use((req, res, next) => {
  req.event = db.prepare('SELECT * FROM events WHERE client_token = ?').get(req.params.ctoken);
  if (!req.event) return res.status(404).send('Dashboard not found. Ask your planner for a fresh link.');
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

// Optional PIN: once entered, remembered on this device with a signed cookie.
const pinCookie = (e) => `cd_client_${e.id}`;
const pinValue = (e) => sign(`${e.client_token}:${e.client_pin}`);
const pinPage = (e, error) => layout({ title: e.title, nav: false, body: html`
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
  const tab = ['calls', 'activity'].includes(req.query.tab) ? req.query.tab : 'guests';
  // Clients see guest-facing activity only (not the team's internal notes or assignments).
  const activity = tab === 'activity' ? db.prepare(`SELECT a.*, g.name guest_name FROM activities a JOIN guests g ON g.id = a.guest_id
    WHERE a.event_id = ? AND a.kind IN ('rsvp', 'id', 'invite') ORDER BY a.created_at DESC, a.id DESC LIMIT 200`).all(e.id) : [];
  res.send(layout({ title: e.title, nav: false, body: html`
    <div class="head"><div><p class="eyebrow">Guest dashboard</p><h1 class="couple">${e.title}</h1>
      <p class="muted">${[fmtDate(e.event_date), e.venue, e.city].filter(Boolean).join(' · ')}</p></div>
      <div class="actions"><a class="btn" href="${base}/export.csv">Download guest list (CSV)</a></div></div>
    ${S.statCards(S.stats(e.id))}
    <nav class="tabs"><a class="${tab === 'guests' ? 'on' : ''}" href="${base}">Guests</a><a class="${tab === 'activity' ? 'on' : ''}" href="${base}?tab=activity">Latest updates</a><a class="${tab === 'calls' ? 'on' : ''}" href="${base}?tab=calls">Calls &amp; recordings</a></nav>
    ${tab === 'activity' ? html`<div class="card">${S.timeline(activity, { showGuest: true })}</div>`
    : tab === 'calls' ? S.callsTable(S.eventCalls(e.id), (c) => `${base}/calls/${c.id}/recording`) : html`
      ${S.filterBar(e.id, filter)}
      <div class="table-wrap"><table class="guests">
        <tr><th>Guest</th><th>Side / group</th><th>RSVP</th><th>People</th><th>Arrival</th><th>Departure</th><th>Stay</th><th>Food</th><th>ID</th></tr>
        ${guests.map((g) => html`<tr>
          <td><strong>${g.name}</strong><br><small class="muted">${g.phone || ''}</small>${g.guest_notes ? html`<br><small class="quote">“${g.guest_notes}”</small>` : ''}</td>
          <td>${g.side || ''}<br><small class="muted">${g.group_name || ''}</small></td>
          <td>${S.badge(g.rsvp_status)}</td>
          <td>${g.rsvp_status === 'yes' ? g.pax ?? 1 : '–'} / ${g.max_pax}</td>
          <td>${fmtDate(g.arrival_date)}${g.arrival_mode || g.arrival_details ? html`<br><small class="muted">${[g.arrival_mode, g.arrival_details].filter(Boolean).join(' · ')}</small>` : ''}</td>
          <td>${fmtDate(g.departure_date)}</td>
          <td>${g.needs_stay == null ? '' : g.needs_stay ? 'Yes' : 'No'}</td>
          <td>${g.dietary || ''}</td>
          <td>${g.id_file ? html`<a target="_blank" href="${base}/guests/${g.id}/id-file">${g.id_type || 'View'}</a><br><small class="muted">${maskId(g.id_number)}</small>` : g.rsvp_status === 'yes' && e.require_id ? html`<span class="muted">Pending</span>` : ''}</td>
        </tr>`)}
      </table></div>`}
    <p class="muted small center">Managed by Candid Dulhan · This link is private — please don’t forward it.</p>` }));
});

r.get('/export.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="guest-list.csv"');
  res.send('﻿' + S.guestsCsv(req.event.id, { withIdNumbers: true }));
});

r.get('/guests/:id/id-file', (req, res) => S.sendUpload(res, 'ids', guestOf(req)?.id_file));
r.get('/calls/:id/recording', (req, res) => S.sendUpload(res, 'recordings',
  db.prepare('SELECT recording_file FROM calls WHERE id = ? AND event_id = ?').get(req.params.id, req.event.id)?.recording_file));

module.exports = r;
