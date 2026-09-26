// WhatsApp screens: per-wedding campaigns & inbox, platform setup, Meta webhook, guest conversation actions.
const express = require('express');
const db = require('../db');
const layout = require('../layout');
const { requireRole } = require('../auth');
const { html, fmtDate } = require('../util');
const S = require('../shared');
const T = require('../tenancy');
const W = require('../wedding');
const WA = require('../whatsapp');

const r = express.Router();
const admin = requireRole('admin');
const back = (res, url, msg) => res.redirect(`${url}${msg ? `${url.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}` : ''}`);
const STATUS_ICON = { queued: '🕓', simulated: '🧪', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠', received: '⬅' };

// ---------------- Meta webhook ----------------
r.get('/webhooks/whatsapp', (req, res) => {
  const c = WA.cfg();
  if (req.query['hub.mode'] === 'subscribe' && c.verifyToken && req.query['hub.verify_token'] === c.verifyToken) return res.send(String(req.query['hub.challenge'] || ''));
  res.sendStatus(403);
});
r.post('/webhooks/whatsapp', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!WA.verifySignature(raw, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return res.sendStatus(400); }
  res.sendStatus(200); // acknowledge fast; Meta retries slow webhooks
  WA.handleWebhook(body).catch((err) => console.error('WhatsApp webhook error', err));
});

const modeBadge = () => (WA.live()
  ? html`<span class="badge yes">Live · WhatsApp Business</span>`
  : html`<span class="badge maybe">Test mode — nothing is sent</span>`);

// ---------------- Per-wedding WhatsApp tab ----------------
r.get('/admin/events/:id/whatsapp', admin, (req, res) => {
  const e0 = T.loadEvent(req, res, req.params.id);
  if (!e0) return;
  const e = WA.eventWithOrg(e0.id);
  const allowed = WA.canSend(e);
  const counts = Object.fromEntries(Object.keys(WA.AUDIENCES).map((k) => [k, WA.audienceGuests(e.id, k).length]));
  const sample = db.prepare("SELECT * FROM guests WHERE event_id = ? AND phone IS NOT NULL ORDER BY rsvp_status = 'pending' DESC, id LIMIT 1").get(e.id);
  const previews = Object.fromEntries(Object.entries(WA.TEMPLATES).filter(([, t]) => t.params)
    .map(([k, t]) => [k, sample ? WA.render(t, t.params(e, sample).map(WA.flat)) : t.text]));
  const campaigns = WA.campaignStats(e.id);
  const inbox = WA.inbox(e.id, 30);
  const log = db.prepare(`SELECT m.*, g.name guest_name FROM wa_messages m LEFT JOIN guests g ON g.id = m.guest_id
    WHERE m.event_id = ? ORDER BY m.id DESC LIMIT 60`).all(e.id);
  res.send(layout({ title: `WhatsApp · ${e.title}`, user: req.user, flash: req.query.msg, body: html`
    <div class="head"><div><h1>${e.title}</h1><p class="muted">${[fmtDate(e.event_date), e.venue, e.city].filter(Boolean).join(' · ')}</p></div><div>${modeBadge()}</div></div>
    ${W.eventNav(e, 'whatsapp', { owner: T.ownsEvent(req.user, e) })}
    ${!allowed ? html`<div class="card service"><strong>Bulk WhatsApp is part of the Candid Dulhan RSVP desk.</strong>
      <span class="muted">Request the RSVP desk on the Guests tab to send invites, reminders and itineraries from our official WhatsApp number.</span></div>` : ''}
    <div class="grid-crm">
      <div>
        <form method="post" action="/admin/events/${e.id}/whatsapp/send" class="card form wa-send" data-confirm="Send this WhatsApp message now?">
          <h3>📣 Send a WhatsApp message</h3>
          <div class="fields">
            <label>Message<select name="purpose" data-wa-purpose>${Object.entries(WA.TEMPLATES).filter(([, t]) => t.params).map(([k, t]) => html`<option value="${k}">${t.label}</option>`)}</select></label>
            <label>To<select name="audience">${Object.entries(WA.AUDIENCES).map(([k, [label]]) => html`<option value="${k}" ${k === 'pending' ? 'selected' : ''}>${label} (${counts[k]})</option>`)}</select></label>
          </div>
          <p class="muted small">Preview${sample ? ` for ${sample.name}` : ''}:</p>
          ${Object.entries(previews).map(([k, p]) => html`<div class="wa-bubble" data-preview="${k}" ${k === 'invite' ? '' : 'hidden'}>${p}
            ${WA.TEMPLATES[k].button?.type === 'quick' ? html`<div class="wa-buttons">${WA.TEMPLATES[k].button.labels.map((l) => html`<span>${l}</span>`)}</div>` : ''}
            ${WA.TEMPLATES[k].button?.type === 'url' ? html`<div class="wa-buttons"><span>🔗 ${WA.TEMPLATES[k].button.label}</span></div>` : ''}</div>`)}
          <button class="primary" ${allowed ? '' : 'disabled'}>Send</button>
          <p class="muted small">Uses WhatsApp-approved templates. Guests who tap “Yes, attending”, “Can’t attend” or “Please call me” are updated automatically.</p>
        </form>
        <div class="card"><h3>Campaigns</h3>
          ${campaigns.length ? html`<div class="table-wrap flat"><table class="mini"><tr><th>When</th><th>Message</th><th>Audience</th><th>Sent</th><th>Delivered</th><th>Read</th><th>Failed</th><th>Replies</th></tr>
            ${campaigns.map((c) => html`<tr><td>${fmtDate(c.created_at)}<br><small class="muted">${c.source === 'auto' ? '⚙️ automation' : c.created_by || ''}</small></td>
              <td>${WA.TEMPLATES[c.purpose]?.label || c.purpose}</td><td>${WA.AUDIENCES[c.audience]?.[0] || c.audience || ''}</td>
              <td>${c.sent || 0}/${c.total}</td><td>${c.delivered || 0}</td><td>${c.read || 0}</td><td>${c.failed ? html`<span class="overdue">${c.failed}</span>` : 0}</td><td>${c.replies || 0}</td></tr>`)}
          </table></div>` : html`<p class="muted">No messages sent yet.</p>`}
        </div>
      </div>
      <div>
        <div class="card"><h3>💬 Replies inbox</h3>
          ${inbox.length ? html`<ul class="timeline">${inbox.map((m) => html`<li><span class="tl-icon">💬</span><div>
            <div>${m.guest_id ? html`<a href="/admin/guests/${m.guest_id}#whatsapp"><strong>${m.guest_name}</strong></a>` : html`<strong>+${m.phone}</strong>`} · ${m.body}</div>
            <small class="muted">${fmtDate(m.created_at)}</small></div></li>`)}</ul>` : html`<p class="muted">Guest replies will appear here.</p>`}
        </div>
        <div class="card"><h3>Message log</h3>
          ${log.length ? html`<div class="table-wrap flat scroll-box"><table class="mini"><tr><th>When</th><th>Guest</th><th></th><th>Status</th></tr>
            ${log.map((m) => html`<tr><td>${fmtDate(m.created_at)}</td><td>${m.guest_name || `+${m.phone}`}</td>
              <td>${m.direction === 'in' ? '⬅ reply' : WA.TEMPLATES[m.purpose]?.label || m.purpose || 'message'}</td>
              <td class="wa-st ${m.status}" title="${m.error || ''}">${STATUS_ICON[m.status] || ''} ${m.status}</td></tr>`)}
          </table></div>` : html`<p class="muted">Nothing yet.</p>`}
        </div>
      </div>
    </div>` }));
});

async function sendAndReport(req, res, e, purpose, guests, audience) {
  if (!WA.TEMPLATES[purpose]?.params) return back(res, `/admin/events/${e.id}/whatsapp`, 'Choose a message');
  if (!WA.canSend(e)) return back(res, `/admin/events/${e.id}/whatsapp`, 'Bulk WhatsApp needs the Candid Dulhan RSVP desk for this wedding');
  if (!guests.length) return back(res, `/admin/events/${e.id}/whatsapp`, 'No guests with a mobile number match that audience');
  const job = WA.runCampaign(e.id, purpose, guests, { who: req.user.name, audience });
  if (guests.length > 40 && WA.live()) {
    job.catch((err) => console.error('WhatsApp campaign error', err));
    return back(res, `/admin/events/${e.id}/whatsapp`, `Sending to ${guests.length} guests in the background — refresh to see progress`);
  }
  const r2 = await job;
  back(res, `/admin/events/${e.id}/whatsapp`, `${WA.live() ? 'Sent' : 'Test mode: recorded'} ${r2.sent} message${r2.sent === 1 ? '' : 's'}${r2.failed ? `, ${r2.failed} failed` : ''}${r2.skipped ? `, ${r2.skipped} without a valid mobile` : ''}`);
}

r.post('/admin/events/:id/whatsapp/send', admin, async (req, res, next) => {
  const e0 = T.loadEvent(req, res, req.params.id);
  if (!e0) return;
  const e = WA.eventWithOrg(e0.id);
  try { await sendAndReport(req, res, e, req.body.purpose, WA.audienceGuests(e.id, req.body.audience, req.body.guest_ids), req.body.audience); } catch (err) { next(err); }
});

// ---------------- Guest conversation ----------------
function guestPanel(g, e) {
  const msgs = db.prepare('SELECT * FROM wa_messages WHERE guest_id = ? ORDER BY id DESC LIMIT 30').all(g.id);
  const canReply = WA.canReply(g.id);
  return html`<div class="card" id="whatsapp"><h3>💬 WhatsApp ${WA.live() ? '' : html`<small class="muted">(test mode)</small>`}</h3>
    ${msgs.length ? html`<div class="wa-thread">${[...msgs].reverse().map((m) => html`<div class="wa-msg ${m.direction}">
      <div>${m.body}</div><small>${fmtDate(m.created_at)} ${m.direction === 'out' ? html`· <span class="wa-st ${m.status}">${STATUS_ICON[m.status] || ''} ${m.status}</span>` : ''}</small></div>`)}</div>`
      : html`<p class="muted">No WhatsApp messages yet.</p>`}
    ${WA.canSend(e) && g.phone ? html`<form method="post" action="/admin/guests/${g.id}/wa/send" class="inline-form top-gap">
      <select name="purpose">${Object.entries(WA.TEMPLATES).filter(([, t]) => t.params).map(([k, t]) => html`<option value="${k}">${t.label}</option>`)}</select>
      <button class="btn sm">Send template</button></form>` : ''}
    ${canReply ? html`<form method="post" action="/admin/guests/${g.id}/wa/reply" class="form noteform top-gap">
      <textarea name="text" rows="2" required placeholder="Reply (allowed for 24 hours after the guest’s last message)"></textarea><button class="sm">Reply</button></form>` : ''}
    ${!WA.live() && g.phone ? html`<div class="sim top-gap"><small class="muted">Test mode — pretend the guest replied:</small>
      ${['yes', 'no', 'call'].map((a) => html`<form method="post" action="/admin/guests/${g.id}/wa/simulate" class="inline"><button name="answer" value="${a}" class="btn sm">${{ yes: '“Yes, attending”', no: '“Can’t attend”', call: '“Please call me”' }[a]}</button></form>`)}</div>` : ''}
  </div>`;
}

r.post('/admin/guests/:id/wa/send', admin, async (req, res) => {
  const { g, e } = T.loadGuest(req, res, req.params.id);
  if (!g) return;
  const ew = WA.eventWithOrg(e.id);
  if (!WA.canSend(ew) || !WA.TEMPLATES[req.body.purpose]?.params) return back(res, `/admin/guests/${g.id}#whatsapp`, 'Not available for this wedding');
  const r2 = await WA.sendTemplate(ew, g, req.body.purpose, { who: req.user.name });
  back(res, `/admin/guests/${g.id}#whatsapp`, r2.error ? `WhatsApp failed: ${r2.error}` : r2.skipped ? 'Guest has no valid mobile' : 'WhatsApp sent');
});

r.post('/admin/guests/:id/wa/reply', admin, async (req, res) => {
  const { g, e } = T.loadGuest(req, res, req.params.id);
  if (!g) return;
  if (!WA.canReply(g.id)) return back(res, `/admin/guests/${g.id}#whatsapp`, 'The 24-hour reply window has closed — send a template instead');
  const r2 = await WA.sendText(e, g, String(req.body.text || '').trim().slice(0, 2000), { who: req.user.name });
  back(res, `/admin/guests/${g.id}#whatsapp`, r2.error ? `WhatsApp failed: ${r2.error}` : 'Reply sent');
});

r.post('/admin/guests/:id/wa/simulate', admin, async (req, res) => {
  const { g } = T.loadGuest(req, res, req.params.id);
  if (!g) return;
  if (WA.live()) return back(res, `/admin/guests/${g.id}`, 'Only available in test mode');
  await WA.simulateReply(g, { answer: ['yes', 'no', 'call'].includes(req.body.answer) ? req.body.answer : null, text: req.body.text });
  back(res, `/admin/guests/${g.id}#whatsapp`, 'Simulated guest reply processed');
});

// ---------------- Platform setup page ----------------
r.get('/admin/whatsapp', admin, (req, res) => {
  if (!req.user.platform) return res.status(404).send('Not found');
  const c = WA.cfg();
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
  res.send(layout({ title: 'WhatsApp setup', user: req.user, flash: req.query.msg, body: html`
    <p><a href="/admin/platform">← Platform</a></p>
    <div class="head"><h1>WhatsApp Business setup</h1>${modeBadge()}</div>
    <div class="card"><h3>Status</h3><table class="mini">
      <tr><td>Access token</td><td>${c.token ? '✓ set' : '✗ WHATSAPP_TOKEN missing'}</td></tr>
      <tr><td>Phone number ID</td><td>${c.phoneId ? `✓ ${c.phoneId}` : '✗ WHATSAPP_PHONE_NUMBER_ID missing'}</td></tr>
      <tr><td>App secret (webhook signature)</td><td>${c.appSecret ? '✓ set' : '✗ WHATSAPP_APP_SECRET missing'}</td></tr>
      <tr><td>Webhook verify token</td><td>${c.verifyToken ? '✓ set' : '✗ WHATSAPP_VERIFY_TOKEN missing'}</td></tr>
      <tr><td>Webhook URL (paste in Meta)</td><td><code>${base}/webhooks/whatsapp</code></td></tr>
      <tr><td>Partner companies can send</td><td>${c.partnerAccess === 'all' ? 'All weddings' : 'Only weddings using your RSVP desk'} <small class="muted">(WHATSAPP_PARTNER_ACCESS)</small></td></tr>
    </table></div>
    <div class="card"><h3>Templates to create in WhatsApp Manager</h3>
      <p class="muted">Meta must approve each template before it can be sent (usually minutes to a day). Create them with exactly these names and text, language “${c.lang}”.</p>
      ${Object.values(WA.TEMPLATES).map((t) => html`<div class="tpl"><div><strong>${t.name}</strong> <span class="badge pending">${t.category}</span> <span class="muted">${t.label}</span></div>
        <pre>${t.text}</pre>${t.button ? html`<p class="muted small">Buttons: ${t.button.type === 'quick' ? `Quick replies — ${t.button.labels.join(' / ')}` : `${t.button.label} — ${t.button.note.replace('YOUR-DOMAIN', base.replace(/^https?:\/\//, ''))}`}</p>` : ''}</div>`)}
    </div>` }));
});

module.exports = { router: r, guestPanel };
