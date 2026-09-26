// Per-wedding automation settings and run log.
const express = require('express');
const db = require('../db');
const layout = require('../layout');
const { requireRole } = require('../auth');
const { html, fmtDate } = require('../util');
const S = require('../shared');
const T = require('../tenancy');
const W = require('../wedding');
const WA = require('../whatsapp');
const A = require('../automation');

const r = express.Router();
const admin = requireRole('admin');
const back = (res, url, msg) => res.redirect(`${url}${msg ? `${url.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}` : ''}`);
const FIELD_LABEL = { every: 'Every (days)', max: 'At most (times)', after: 'After (reminders)', days: 'Days', hour: 'Hour (0–23)' };

r.get('/admin/events/:id/automation', admin, (req, res) => {
  const e0 = T.loadEvent(req, res, req.params.id);
  if (!e0) return;
  const e = WA.eventWithOrg(e0.id);
  const st = A.settings(e.id);
  const waOk = WA.canSend(e);
  const runs = db.prepare(`SELECT a.*, g.name guest_name FROM activities a LEFT JOIN guests g ON g.id = a.guest_id
    WHERE a.event_id = ? AND a.actor = 'Automation' ORDER BY a.id DESC LIMIT 40`).all(e.id);
  res.send(layout({ title: `Automation · ${e.title}`, user: req.user, flash: req.query.msg, body: html`
    <div class="head"><div><h1>${e.title}</h1><p class="muted">${[fmtDate(e.event_date), e.venue, e.city].filter(Boolean).join(' · ')}</p></div>
      <form method="post" action="/admin/events/${e.id}/automation/run"><button class="btn">▶ Run now</button></form></div>
    ${W.eventNav(e, 'automation', { owner: T.ownsEvent(req.user, e) })}
    <p class="muted">Switch on what should happen by itself. Rules run every few minutes; WhatsApp messages go out only between 9 am and 8 pm (India time), never twice in a day to the same guest.
      ${WA.live() ? '' : html` <strong>WhatsApp is in test mode</strong> — messages are recorded, not sent.`}</p>
    ${!waOk ? html`<div class="card service"><strong>WhatsApp rules need the Candid Dulhan RSVP desk for this wedding.</strong> <span class="muted">Other rules work without it.</span></div>` : ''}
    <form method="post" action="/admin/events/${e.id}/automation" class="auto-grid">
      ${Object.entries(A.RULES).map(([k, rule]) => { const s = st[k]; return html`<div class="card auto-rule ${s.enabled ? 'on' : ''}">
        <label class="switch"><input type="checkbox" name="on_${k}" value="1" ${s.enabled ? 'checked' : ''} ${k === 'id_retention' && !e.id_retention_days ? 'disabled' : ''}>
          <span>${rule.icon} <strong>${rule.label}</strong>${rule.whatsapp ? html` <small class="muted">WhatsApp</small>` : ''}</span></label>
        <p class="muted small">${rule.describe(s.config, e)}</p>
        ${Object.keys(rule.defaults).length ? html`<div class="inline-form">${Object.entries(s.config).map(([f, v]) => html`<label class="mini-field">${FIELD_LABEL[f] || f}
          <input type="number" name="${k}_${f}" value="${v}" min="0" max="60"></label>`)}</div>` : ''}
        ${s.last_run_at ? html`<p class="muted small">Last checked ${fmtDate(s.last_run_at)}</p>` : ''}
      </div>`; })}
      <div class="auto-save"><button class="primary">Save automation</button></div>
    </form>
    <div class="card"><h3>What automation did</h3>${S.timeline(runs, { showGuest: true })}</div>` }));
});

r.post('/admin/events/:id/automation', admin, (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  for (const [k, rule] of Object.entries(A.RULES)) {
    const config = Object.fromEntries(Object.keys(rule.defaults).map((f) => [f, req.body[`${k}_${f}`]]));
    A.save(e.id, k, { enabled: !!req.body[`on_${k}`], config });
  }
  S.logActivity(e.id, null, req.user.name, 'auto', `Automation settings updated: ${Object.keys(A.RULES).filter((k) => req.body[`on_${k}`]).map((k) => A.RULES[k].label).join(', ') || 'all off'}`);
  back(res, `/admin/events/${e.id}/automation`, 'Automation saved');
});

r.post('/admin/events/:id/automation/run', admin, async (req, res, next) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  try {
    const out = await A.runEvent(e.id, { force: true });
    back(res, `/admin/events/${e.id}/automation`, out.length ? out.join(' · ') : 'Nothing to do right now');
  } catch (err) { next(err); }
});

module.exports = { router: r };
