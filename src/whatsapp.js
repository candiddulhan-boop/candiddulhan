// WhatsApp Business (Meta Cloud API): approved templates, bulk campaigns, delivery/read receipts, and guest replies
// (quick-reply buttons update RSVPs automatically). Without credentials it runs in test mode: messages are recorded
// as "simulated" and nothing leaves the server.
const crypto = require('node:crypto');
const db = require('./db');
const W = require('./wedding');
const S = require('./shared');
const { normPhone, phoneKey, fmtDate } = require('./util');

const cfg = () => ({
  token: process.env.WHATSAPP_TOKEN || '',
  phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  appSecret: process.env.WHATSAPP_APP_SECRET || '',
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
  version: process.env.WHATSAPP_API_VERSION || 'v23.0',
  lang: process.env.WHATSAPP_TEMPLATE_LANG || 'en',
  partnerAccess: process.env.WHATSAPP_PARTNER_ACCESS || 'service', // 'service' | 'all'
});
const live = () => { const c = cfg(); return !!(c.token && c.phoneId); };

db.exec(`
CREATE TABLE IF NOT EXISTS wa_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL, audience TEXT, total INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual', created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
  campaign_id INTEGER REFERENCES wa_campaigns(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,          -- out | in
  purpose TEXT, template TEXT,
  body TEXT, phone TEXT,
  wa_id TEXT,                       -- Meta message id
  status TEXT NOT NULL,             -- queued | sent | delivered | read | failed | simulated | received
  error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS wa_messages_event ON wa_messages(event_id, created_at);
CREATE INDEX IF NOT EXISTS wa_messages_guest ON wa_messages(guest_id, purpose);
CREATE INDEX IF NOT EXISTS wa_messages_waid ON wa_messages(wa_id);
`);

// ---------------- Templates ----------------
// Create these in Meta Business Manager → WhatsApp Manager → Message templates, with exactly this text.
// Parameters must not contain new lines, so values are flattened.
const flat = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' · ').replace(/ {4,}/g, '   ').trim().slice(0, 900) || '-';
const whenText = (e) => [fmtDate(e.event_date), [e.venue, e.city].filter(Boolean).join(', ')].filter(Boolean).join(' at ') || 'the wedding';
const host = (e) => (e.org_is_platform ? 'the families' : e.org_name);

function itineraryText(e, g) {
  const fns = W.functionsOf(e.id);
  const a = W.guestFunctions(g.id);
  const parts = fns.filter((f) => a.get(f.id)?.rsvp === 'yes')
    .map((f) => `${f.name}: ${[fmtDate(f.date), f.time, f.venue].filter(Boolean).join(' ')}${f.dress_code ? ` (dress: ${f.dress_code})` : ''}`);
  const hotel = g.hotel_id ? db.prepare('SELECT name FROM hotels WHERE id = ?').get(g.hotel_id)?.name : null;
  if (hotel) parts.push(`Stay: ${hotel}${g.room_no ? ` room ${g.room_no}` : ''}`);
  if (g.pickup_vehicle) parts.push(`Pickup: ${g.pickup_vehicle}`);
  return parts.join(' | ') || 'details will follow shortly';
}

const TEMPLATES = {
  invite: {
    label: 'Wedding invitation', name: 'cd_wedding_invite', category: 'MARKETING',
    text: 'Namaste {{1}} 🙏 With great joy, {{2}} invite you to the wedding of {{3}} on {{4}}. Please confirm your presence using the button below.',
    params: (e, g) => [g.name, host(e), e.title, whenText(e)],
    button: { type: 'url', label: 'RSVP now', note: 'URL button, dynamic: https://YOUR-DOMAIN/i/{{1}}' },
  },
  reminder: {
    label: 'RSVP reminder (reply buttons)', name: 'cd_rsvp_reminder', category: 'UTILITY',
    text: 'Namaste {{1}}, a gentle reminder to confirm your attendance for the wedding of {{2}} on {{3}}. Please tap a button below to reply.',
    params: (e, g) => [g.name, e.title, whenText(e)],
    button: { type: 'quick', labels: ['Yes, attending', 'Can’t attend', 'Please call me'], payloads: ['rsvp:yes', 'rsvp:no', 'rsvp:call'] },
  },
  id_request: {
    label: 'ID request', name: 'cd_id_request', category: 'UTILITY',
    text: 'Namaste {{1}}, for hotel check-in at the wedding of {{2}} we need a government ID for each adult in your party. Please upload them securely using the button below.',
    params: (e, g) => [g.name, e.title],
    button: { type: 'url', label: 'Upload IDs', note: 'URL button, dynamic: https://YOUR-DOMAIN/i/{{1}}' },
  },
  travel: {
    label: 'Travel details request', name: 'cd_travel_details', category: 'UTILITY',
    text: 'Namaste {{1}}, to arrange your pickup and stay for the wedding of {{2}}, please share your arrival and departure details using the button below.',
    params: (e, g) => [g.name, e.title],
    button: { type: 'url', label: 'Share travel details', note: 'URL button, dynamic: https://YOUR-DOMAIN/i/{{1}}' },
  },
  itinerary: {
    label: 'Personal itinerary', name: 'cd_itinerary', category: 'UTILITY',
    text: 'Namaste {{1}}! Here is your plan for the wedding of {{2}}: {{3}}. We look forward to welcoming you.',
    params: (e, g) => [g.name, e.title, itineraryText(e, g)],
  },
  thanks: {
    label: 'Thank you', name: 'cd_thank_you', category: 'MARKETING',
    text: 'Dear {{1}}, thank you for celebrating the wedding of {{2}} with us. Your blessings made it special! 🙏',
    params: (e, g) => [g.name, e.title],
  },
  digest: {
    label: 'Daily summary to planner', name: 'cd_planner_digest', category: 'UTILITY',
    text: 'Daily update for {{1}}: {{2}} confirmed ({{3}} people), {{4}} awaiting reply, {{5}} IDs pending, {{6}} pickups without a vehicle.',
    params: null,
  },
};

// Text preview of a template for one guest.
const render = (tpl, params) => tpl.text.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '');

// ---------------- Who may send ----------------
function canSend(e) {
  if (e.org_id === db.platformOrgId) return true;
  return cfg().partnerAccess === 'all' || e.service_status === 'active';
}
const eventWithOrg = (id) => db.prepare('SELECT e.*, o.name org_name, o.is_platform org_is_platform FROM events e JOIN orgs o ON o.id = e.org_id WHERE e.id = ?').get(id);

// ---------------- Low-level send ----------------
async function graph(payload) {
  const c = cfg();
  const res = await fetch(`https://graph.facebook.com/${c.version}/${c.phoneId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.error_data?.details || data?.error?.message || `WhatsApp API error ${res.status}`);
  return data.messages?.[0]?.id;
}

function record(row) {
  const info = db.prepare(`INSERT INTO wa_messages (event_id, guest_id, campaign_id, direction, purpose, template, body, phone, wa_id, status, error, created_by)
    VALUES (@event_id, @guest_id, @campaign_id, @direction, @purpose, @template, @body, @phone, @wa_id, @status, @error, @created_by)`).run({
    event_id: null, guest_id: null, campaign_id: null, purpose: null, template: null, body: null, phone: null, wa_id: null, error: null, created_by: null, ...row,
  });
  return Number(info.lastInsertRowid);
}

// `params` overrides the template's own values (used for messages to planners rather than guests).
async function sendTemplate(e, g, purpose, { campaignId = null, who = null, params: given = null } = {}) {
  const tpl = TEMPLATES[purpose];
  if (!tpl || !(tpl.params || given)) throw new Error('Unknown template');
  const phone = normPhone(g.phone);
  if (phone.length < 12) return { skipped: 'no valid mobile' };
  const params = (given || tpl.params(e, g)).map(flat);
  const body = render(tpl, params);
  const id = record({ event_id: e.id, guest_id: g.id, campaign_id: campaignId, direction: 'out', purpose, template: tpl.name, body, phone,
    status: 'queued', created_by: who });
  const components = [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }];
  if (tpl.button?.type === 'url') components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: g.token }] });
  if (tpl.button?.type === 'quick') {
    tpl.button.payloads.forEach((p, i) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: `${p}:${g.token}` }] }));
  }
  try {
    const waId = live()
      ? await graph({ to: phone, type: 'template', template: { name: tpl.name, language: { code: cfg().lang }, components } })
      : `sim-${id}`;
    db.prepare("UPDATE wa_messages SET wa_id = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(waId, live() ? 'sent' : 'simulated', id);
    if (purpose === 'invite') db.prepare("UPDATE guests SET invited_at = COALESCE(invited_at, datetime('now')) WHERE id = ?").run(g.id);
    if (g.id) S.logActivity(e.id, g.id, who || 'Automation', 'whatsapp', `WhatsApp ${tpl.label.toLowerCase()} ${live() ? 'sent' : 'sent (test mode)'}`);
    return { id };
  } catch (err) {
    db.prepare("UPDATE wa_messages SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?").run(err.message.slice(0, 300), id);
    return { id, error: err.message };
  }
}

async function sendText(e, g, text, { who = null } = {}) {
  const phone = normPhone(g.phone);
  const id = record({ event_id: e.id, guest_id: g.id, direction: 'out', purpose: 'reply', body: text, phone, status: 'queued', created_by: who });
  try {
    const waId = live() ? await graph({ to: phone, type: 'text', text: { body: text.slice(0, 4000) } }) : `sim-${id}`;
    db.prepare("UPDATE wa_messages SET wa_id = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(waId, live() ? 'sent' : 'simulated', id);
    return { id };
  } catch (err) {
    db.prepare("UPDATE wa_messages SET status = 'failed', error = ? WHERE id = ?").run(err.message.slice(0, 300), id);
    return { id, error: err.message };
  }
}

// Free-form replies are only allowed within 24 hours of the guest's last message.
function canReply(guestId) {
  return !!db.prepare("SELECT 1 FROM wa_messages WHERE guest_id = ? AND direction = 'in' AND created_at >= datetime('now', '-24 hours')").get(guestId);
}

// ---------------- Audiences & campaigns ----------------
const AUDIENCES = {
  not_invited: ['Not invited yet', "g.invited_at IS NULL"],
  pending: ['Haven’t replied', "g.rsvp_status = 'pending'"],
  open: ['Not confirmed (awaiting + maybe)', "g.rsvp_status IN ('pending','maybe')"],
  attending: ['Attending', "g.rsvp_status = 'yes'"],
  missing_id: ['Attending, ID missing', "g.rsvp_status = 'yes' AND g.id_file IS NULL"],
  no_travel: ['Attending, no arrival details', "g.rsvp_status = 'yes' AND (g.arrival_date IS NULL OR g.arrival_date = '')"],
  all: ['Everyone', '1 = 1'],
};
function audienceGuests(eventId, audience, ids) {
  if (audience === 'selected') {
    const list = [].concat(ids || []).map(Number).filter(Boolean);
    if (!list.length) return [];
    return db.prepare(`SELECT g.* FROM guests g WHERE g.event_id = ? AND g.phone IS NOT NULL AND g.id IN (${list.map(() => '?').join(',')})`).all(eventId, ...list);
  }
  const a = AUDIENCES[audience];
  if (!a) return [];
  return db.prepare(`SELECT g.* FROM guests g WHERE g.event_id = ? AND g.phone IS NOT NULL AND g.phone != '' AND ${a[1]} ORDER BY g.name`).all(eventId);
}

async function runCampaign(eventId, purpose, guests, { who, source = 'manual', audience } = {}) {
  const e = eventWithOrg(eventId);
  const cid = Number(db.prepare('INSERT INTO wa_campaigns (event_id, purpose, audience, total, source, created_by) VALUES (?,?,?,?,?,?)')
    .run(e.id, purpose, audience || null, guests.length, source, who || null).lastInsertRowid);
  let sent = 0, failed = 0, skipped = 0;
  for (const g of guests) {
    const r = await sendTemplate(e, g, purpose, { campaignId: cid, who });
    if (r.skipped) skipped++; else if (r.error) failed++; else sent++;
    if (live()) await new Promise((ok) => setTimeout(ok, 40)); // stay well under Meta's per-second limits
  }
  return { campaignId: cid, sent, failed, skipped };
}

function campaignStats(eventId) {
  return db.prepare(`SELECT c.*,
      SUM(m.status IN ('sent','delivered','read','simulated')) sent, SUM(m.status IN ('delivered','read')) delivered,
      SUM(m.status = 'read') read, SUM(m.status = 'failed') failed,
      (SELECT COUNT(*) FROM wa_messages r WHERE r.direction = 'in' AND r.guest_id IN (SELECT guest_id FROM wa_messages x WHERE x.campaign_id = c.id)
        AND r.created_at >= c.created_at) replies
    FROM wa_campaigns c LEFT JOIN wa_messages m ON m.campaign_id = c.id WHERE c.event_id = ? GROUP BY c.id ORDER BY c.id DESC LIMIT 30`).all(eventId);
}

// ---------------- Incoming webhook ----------------
function verifySignature(rawBody, header) {
  const secret = cfg().appSecret;
  if (!secret) return !live(); // live mode requires a signed webhook
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(String(header || '')), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Guest the message is about: the button payload carries their RSVP token; otherwise match the phone
// to the guest we most recently messaged.
function guestFor(from, payloadToken) {
  if (payloadToken) {
    const g = db.prepare('SELECT * FROM guests WHERE token = ?').get(payloadToken);
    if (g) return g;
  }
  const key = phoneKey(from);
  const recent = db.prepare(`SELECT g.* FROM wa_messages m JOIN guests g ON g.id = m.guest_id
    WHERE m.direction = 'out' AND m.phone LIKE ? ORDER BY m.id DESC LIMIT 1`).get(`%${key}`);
  if (recent) return recent;
  return db.prepare('SELECT * FROM guests WHERE phone LIKE ? ORDER BY id DESC').all(`%${key.slice(-4)}`).find((g) => phoneKey(g.phone) === key) || null;
}

async function applyAnswer(g, answer) {
  const e = eventWithOrg(g.event_id);
  const fns = W.functionsOf(e.id).filter((f) => W.guestFunctions(g.id).has(f.id));
  if (answer === 'yes' || answer === 'no') {
    if (fns.length) {
      for (const f of fns) W.setFunctionAnswer(g.id, f.id, answer, answer === 'yes' ? W.guestFunctions(g.id).get(f.id)?.pax || g.max_pax : 0);
      W.syncOverall(g.id);
    } else {
      db.prepare("UPDATE guests SET rsvp_status = ?, pax = ?, responded_at = COALESCE(responded_at, datetime('now')) WHERE id = ?")
        .run(answer, answer === 'yes' ? g.pax || g.max_pax : 0, g.id);
    }
    S.logActivity(e.id, g.id, 'Guest', 'rsvp', `Replied on WhatsApp: ${answer === 'yes' ? 'Attending' : 'Declined'}`);
    const base = require('./config').baseUrl;
    await sendText(e, g, answer === 'yes'
      ? `Thank you ${g.name} 🙏 We’re delighted! Please add your family, travel and ID details${base ? ` here: ${base}/i/${g.token}` : ' using your invitation link'} so we can arrange everything.`
      : `Thank you for letting us know, ${g.name}. You will be missed! 🙏`, { who: 'Auto-reply' });
  } else if (answer === 'call') {
    db.prepare("UPDATE guests SET follow_up_at = datetime('now') WHERE id = ?").run(g.id);
    S.logActivity(e.id, g.id, 'Guest', 'followup', 'Asked for a call on WhatsApp — follow-up due now');
    await sendText(e, g, `Sure ${g.name}, our team will call you shortly. 🙏`, { who: 'Auto-reply' });
  }
}

async function handleWebhook(body) {
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const st of v.statuses || []) {
        const rank = { queued: 0, simulated: 1, sent: 1, delivered: 2, read: 3, failed: 4 };
        const m = db.prepare('SELECT * FROM wa_messages WHERE wa_id = ?').get(st.id);
        if (!m || (rank[st.status] ?? 0) < (rank[m.status] ?? 0)) continue; // receipts can arrive out of order
        db.prepare("UPDATE wa_messages SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?")
          .run(st.status, st.errors?.[0] ? `${st.errors[0].code}: ${st.errors[0].title}` : m.error, m.id);
      }
      for (const msg of v.messages || []) {
        let text = '', payload = '';
        if (msg.type === 'text') text = msg.text?.body || '';
        else if (msg.type === 'button') { text = msg.button?.text || ''; payload = msg.button?.payload || ''; }
        else if (msg.type === 'interactive') { const r = msg.interactive?.button_reply || msg.interactive?.list_reply; text = r?.title || ''; payload = r?.id || ''; }
        else text = `[${msg.type}]`;
        const [, answer, tok] = /^rsvp:(yes|no|call):(.+)$/.exec(payload) || [];
        const g = guestFor(msg.from, tok);
        if (db.prepare("SELECT 1 FROM wa_messages WHERE wa_id = ? AND direction = 'in'").get(msg.id)) continue; // duplicate delivery
        record({ event_id: g?.event_id ?? null, guest_id: g?.id ?? null, direction: 'in', body: text.slice(0, 2000), phone: msg.from, wa_id: msg.id, status: 'received' });
        if (!g) continue;
        if (answer) await applyAnswer(g, answer);
        else S.logActivity(g.event_id, g.id, 'Guest', 'whatsapp', `WhatsApp message: “${text.slice(0, 200)}”`);
      }
    }
  }
}

// Test mode: behave as if the guest had tapped a reply button or typed a message.
async function simulateReply(g, { answer, text }) {
  const phone = normPhone(g.phone);
  const msg = answer
    ? { from: phone, id: `sim-in-${Date.now()}`, type: 'button', button: { text: { yes: 'Yes, attending', no: 'Can’t attend', call: 'Please call me' }[answer], payload: `rsvp:${answer}:${g.token}` } }
    : { from: phone, id: `sim-in-${Date.now()}`, type: 'text', text: { body: text || 'Hello' } };
  await handleWebhook({ entry: [{ changes: [{ value: { messages: [msg] } }] }] });
}

function inbox(eventId, limit = 50) {
  return db.prepare(`SELECT m.*, g.name guest_name FROM wa_messages m LEFT JOIN guests g ON g.id = m.guest_id
    WHERE m.event_id = ? AND m.direction = 'in' ORDER BY m.id DESC LIMIT ?`).all(eventId, limit);
}

module.exports = { cfg, live, TEMPLATES, render, flat, AUDIENCES, audienceGuests, runCampaign, campaignStats, sendTemplate, sendText, canReply,
  canSend, eventWithOrg, verifySignature, handleWebhook, simulateReply, inbox, itineraryText };
