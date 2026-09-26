// Reports (Excel / PDF) and AI features for the planner's team.
const express = require('express');
const db = require('../db');
const layout = require('../layout');
const { requireRole } = require('../auth');
const { html, fmtDate } = require('../util');
const S = require('../shared');
const T = require('../tenancy');
const W = require('../wedding');
const AI = require('../ai');
const Smart = require('../smart');
const R = require('../reports');

const r = express.Router();
const admin = requireRole('admin');
const team = requireRole('admin', 'caller');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'wedding';
const sendFile = (res, buf, name, type) => {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(Buffer.from(buf));
};
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDFS = {
  status: ['Guest status report', (id, o) => R.statusPdf(id, o)],
  guests: ['Guest list', (id) => R.guestListPdf(id)],
  rooming: ['Rooming list', (id) => R.roomingPdf(id)],
  pickups: ['Pickup sheet', (id) => R.transportPdf(id, 'arrival')],
  drops: ['Drop sheet', (id) => R.transportPdf(id, 'departure')],
};
const aiError = (res, err) => {
  if (err instanceof AI.AiError) return res.status(400).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: 'Something went wrong with the AI request.' });
};

function alertList(alerts, { limit } = {}) {
  if (!alerts.length) return html`<p class="ok">✓ Nothing urgent — everything is on track.</p>`;
  return html`<ul class="alerts">${alerts.slice(0, limit || alerts.length).map((a) => html`<li class="alert ${a.level}">
    <span class="lvl">${a.level === 'high' ? 'Urgent' : a.level === 'medium' ? 'Soon' : 'FYI'}</span>
    <div><a href="${a.link}"><strong>${a.title}</strong></a><br><small class="muted">${a.detail}</small></div></li>`)}</ul>`;
}

function summaryCard(e, ai) {
  if (!AI.enabled() && !ai) return html`<div class="card ai-card off"><h3>✨ AI status report</h3>
    <p class="muted">Switch on AI by adding <code>ANTHROPIC_API_KEY</code> on the server. You’ll get a written executive summary, risks, next actions and guest-experience ideas — and it goes into the PDF report.</p></div>`;
  return html`<div class="card ai-card"><div class="head"><h3>✨ AI status report</h3>
      ${AI.enabled() ? html`<form method="post" action="/admin/events/${e.id}/ai/summary" data-busy="Writing report…"><button class="btn sm">${ai ? 'Refresh' : 'Generate'}</button></form>`
        : html`<small class="muted">Add <code>ANTHROPIC_API_KEY</code> to refresh</small>`}</div>
    ${ai ? html`<p class="ai-headline">${ai.headline}</p><p>${ai.summary}</p>
      <div class="grid2">
        <div><h4>Top risks</h4><ul>${ai.risks.map((x) => html`<li><strong>${x.title}</strong> — ${x.detail}</li>`)}</ul></div>
        <div><h4>Next 48 hours</h4><ul>${ai.next_actions.map((x) => html`<li>${x}</li>`)}</ul></div>
      </div>
      ${ai.guest_experience_ideas?.length ? html`<h4>Ideas to delight guests</h4><ul>${ai.guest_experience_ideas.map((x) => html`<li>${x}</li>`)}</ul>` : ''}
      <p class="muted small">Prepared ${fmtDate(ai.created_at)}${ai.created_by ? ` by ${ai.created_by}` : ''} · AI can make mistakes — check key numbers.</p>`
    : html`<p class="muted">One click turns this wedding’s live data into a written status report for you and your client.</p>`}
  </div>`;
}

// ---- Reports & AI page ----
r.get('/admin/events/:id/insights', admin, (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  const alerts = Smart.alerts(e);
  const ai = Smart.latestSummary(e.id);
  const pdf = (k) => html`<a class="report-tile" href="/admin/events/${e.id}/report/${k}.pdf"><span class="ext pdf">PDF</span>${PDFS[k][0]}</a>`;
  res.send(layout({ title: `Reports & AI · ${e.title}`, user: req.user, flash: req.query.msg, body: html`
    <div class="head"><div><h1>${e.title}</h1><p class="muted">${[fmtDate(e.event_date), e.venue, e.city].filter(Boolean).join(' · ')}</p></div></div>
    ${W.eventNav(e, 'insights', { owner: T.ownsEvent(req.user, e) })}
    <div class="grid-crm">
      <div>
        ${summaryCard(e, ai)}
        <div class="card ask-card"><h3>💬 Ask anything about your guests</h3>
          ${AI.enabled() ? html`<form class="ask" data-ask="/admin/events/${e.id}/ai/ask">
              <textarea name="q" rows="2" placeholder="e.g. How many Jain guests arrive on 10 Dec and need a pickup?" required></textarea>
              <button class="primary">Ask</button></form>
            <div class="chips">${Smart.SUGGESTED_QUESTIONS.map((q) => html`<button type="button" data-q="${q}">${q}</button>`)}</div>
            <div class="answer" hidden></div>`
          : html`<p class="muted">Available once AI is switched on (<code>ANTHROPIC_API_KEY</code>).</p>`}
        </div>
      </div>
      <div>
        <div class="card"><h3>🚦 Needs attention</h3>${alertList(alerts)}</div>
        <div class="card"><h3>⬇ Download reports</h3>
          <div class="report-grid">
            <a class="report-tile" href="/admin/events/${e.id}/report.xlsx"><span class="ext xls">XLSX</span>Complete workbook<small>Summary, guests, functions, family, rooming, arrivals, departures, food, calls</small></a>
            ${Object.keys(PDFS).map(pdf)}
          </div>
          <p class="muted small">PDFs carry your company’s name. The status report includes the AI summary when one has been generated.</p>
        </div>
      </div>
    </div>` }));
});

r.get('/admin/events/:id/report.xlsx', admin, async (req, res, next) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  try { sendFile(res, await R.excel(e.id), `${slug(e.title)}-guests.xlsx`, XLSX); } catch (err) { next(err); }
});

r.get('/admin/events/:id/report/:kind.pdf', admin, async (req, res, next) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  const spec = PDFS[req.params.kind];
  if (!spec) return res.status(404).send('Not found');
  try { sendFile(res, await spec[1](e.id), `${slug(e.title)}-${req.params.kind}.pdf`, 'application/pdf'); } catch (err) { next(err); }
});

// ---- AI endpoints ----
r.post('/admin/events/:id/ai/summary', admin, async (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  try {
    await Smart.generateSummary(e, req.user.name);
    res.redirect(`/admin/events/${e.id}/insights?msg=${encodeURIComponent('AI status report ready')}`);
  } catch (err) {
    if (!(err instanceof AI.AiError)) console.error(err);
    res.redirect(`/admin/events/${e.id}/insights?msg=${encodeURIComponent(err instanceof AI.AiError ? err.message : 'Could not generate the report.')}`);
  }
});

r.post('/admin/events/:id/ai/ask', admin, express.json({ limit: '10kb' }), async (req, res) => {
  const e = T.loadEvent(req, res, req.params.id);
  if (!e) return;
  try { res.json({ answer: await Smart.ask(e, req.body.q) }); } catch (err) { aiError(res, err); }
});

r.post('/admin/guests/:id/ai/message', admin, express.json({ limit: '10kb' }), async (req, res) => {
  const { g, e } = T.loadGuest(req, res, req.params.id);
  if (!g) return;
  try {
    const text = await Smart.draftMessage(e, g, { purpose: req.body.purpose, language: req.body.language, link: S.inviteUrl(req, g) });
    res.json({ text, wa: g.phone ? `https://wa.me/${require('../util').normPhone(g.phone)}?text=${encodeURIComponent(text)}` : null });
  } catch (err) { aiError(res, err); }
});

r.post('/caller/guest/:id/ai/extract', team, express.json({ limit: '20kb' }), async (req, res) => {
  const { g, e } = T.loadGuest(req, res, req.params.id);
  if (!g) return;
  try { res.json(await Smart.extractFromNotes(e, g, req.body.notes)); } catch (err) { aiError(res, err); }
});

// ---- Client downloads (client dashboard link) ----
function clientEvent(req, res) {
  const e = db.prepare('SELECT * FROM events WHERE client_token = ?').get(req.params.ctoken);
  if (!e) { res.status(404).send('Not found'); return null; }
  if (e.client_pin) {
    const { sign, safeEqual } = require('../auth');
    const got = (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === `cd_client_${e.id}`)?.[1];
    if (!got || !safeEqual(got, sign(`${e.client_token}:${e.client_pin}`))) { res.status(401).send('PIN required'); return null; }
  }
  return e;
}
r.get('/c/:ctoken/report.xlsx', async (req, res, next) => {
  const e = clientEvent(req, res);
  if (!e) return;
  try { sendFile(res, await R.excel(e.id, { forClient: true }), `${slug(e.title)}-guests.xlsx`, XLSX); } catch (err) { next(err); }
});
r.get('/c/:ctoken/report.pdf', async (req, res, next) => {
  const e = clientEvent(req, res);
  if (!e) return;
  try { sendFile(res, await R.statusPdf(e.id, { forClient: true }), `${slug(e.title)}-status.pdf`, 'application/pdf'); } catch (err) { next(err); }
});

module.exports = { router: r, alertList };
