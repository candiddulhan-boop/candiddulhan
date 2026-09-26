// Reports (Excel/PDF), smart alerts, AI features (with a fake Claude client) and PWA files.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { boot, idFrom } = require('./helpers');

const ctx = boot();
const { db } = ctx;
before(ctx.start);
after(ctx.stop);

const AI = require('../src/ai');
let planner, other, eventId, guest;

// Fake Claude: records requests and answers from a queue.
const calls = [];
const replies = [];
const fake = { beta: { messages: { create: async (params) => { calls.push(params); return replies.shift(); } } } };
const reply = (text) => replies.push({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

const getBuf = async (c, url) => {
  const res = await fetch(ctx.base + url, { headers: { cookie: c.cookie } });
  return { status: res.status, type: res.headers.get('content-type'), buf: Buffer.from(await res.arrayBuffer()) };
};
const withCookie = async (form) => {
  const c = ctx.client();
  const res = await fetch(`${ctx.base}/signup`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString() });
  c.cookie = res.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ');
  c.post = (u, f) => fetch(ctx.base + u, { method: 'POST', redirect: 'manual', headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f || {}).toString() })
    .then(async (r) => ({ status: r.status, location: r.headers.get('location') || '', text: await r.text() }));
  c.get = (u) => fetch(ctx.base + u, { redirect: 'manual', headers: { cookie: c.cookie } }).then(async (r) => ({ status: r.status, text: await r.text() }));
  c.json = (u, body) => fetch(ctx.base + u, { method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => { const t = await r.text(); let body; try { body = JSON.parse(t); } catch { body = t; } return { status: r.status, body }; });
  return c;
};

test('setup: a wedding with functions, guests and data', async () => {
  planner = await withCookie({ company: 'Anand Events', name: 'Asha', phone: '9300000001', email: 'asha@anand.test', password: 'secret1' });
  other = await withCookie({ company: 'Other Co', name: 'Om', phone: '9300000002', email: 'om@other.test', password: 'secret2' });
  const r = await planner.post('/admin/events', { title: 'Isha & Kabir', event_date: '2030-02-14', require_id: '1', collect_travel: '1' });
  eventId = idFrom(r.location);
  await planner.post(`/admin/events/${eventId}/functions/defaults`);
  await planner.post(`/admin/events/${eventId}/guests`, { name: 'Verma Family', phone: '9811112222', max_pax: '4' });
  await planner.post(`/admin/events/${eventId}/guests`, { name: 'Dr. Rao', phone: '9811113333', max_pax: '2' });
  guest = db.prepare("SELECT * FROM guests WHERE name = 'Verma Family'").get();
  db.prepare("UPDATE guests SET rsvp_status = 'yes', pax = 4, needs_stay = 1, pickup_required = 1, arrival_date = '2030-02-12', id_number = '999988887777', internal_notes = 'SECRET-NOTE', category = 'VIP' WHERE id = ?").run(guest.id);
});

test('smart alerts flag what needs attention', () => {
  const Smart = require('../src/smart');
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  const titles = Smart.alerts(e).map((a) => a.title).join(' | ');
  assert.match(titles, /1 guests haven’t replied/);
  assert.match(titles, /IDs missing/);
  assert.match(titles, /need a hotel room/);
  assert.match(titles, /pickups still need a vehicle/);
});

test('Excel and PDF reports download for the owner only', async () => {
  const x = await getBuf(planner, `/admin/events/${eventId}/report.xlsx`);
  assert.equal(x.status, 200);
  assert.equal(x.buf.subarray(0, 2).toString(), 'PK', 'xlsx is a zip');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name).slice(0, 3), ['Summary', 'Guests', 'Functions']);
  const guestsSheet = wb.getWorksheet('Guests');
  assert.ok(guestsSheet.getRow(1).values.includes('Internal notes (team only)'));

  for (const kind of ['status', 'guests', 'rooming', 'pickups', 'drops']) {
    const p = await getBuf(planner, `/admin/events/${eventId}/report/${kind}.pdf`);
    assert.equal(p.status, 200, kind);
    assert.equal(p.buf.subarray(0, 4).toString(), '%PDF', `${kind} is a PDF`);
  }
  assert.equal((await getBuf(other, `/admin/events/${eventId}/report.xlsx`)).status, 404, 'other company cannot download');
  assert.equal((await getBuf(other, `/admin/events/${eventId}/report/status.pdf`)).status, 404);

  // Client versions hide internal notes.
  const e = db.prepare('SELECT client_token FROM events WHERE id = ?').get(eventId);
  const cx = await getBuf({ cookie: '' }, `/c/${e.client_token}/report.xlsx`);
  const cwb = new ExcelJS.Workbook();
  await cwb.xlsx.load(cx.buf);
  assert.ok(!cwb.getWorksheet('Guests').getRow(1).values.includes('Internal notes (team only)'));
  const cp = await getBuf({ cookie: '' }, `/c/${e.client_token}/report.pdf`);
  assert.equal(cp.buf.subarray(0, 4).toString(), '%PDF');
});

test('without an API key the AI features explain how to switch on', async () => {
  const page = await planner.get(`/admin/events/${eventId}/insights`);
  assert.equal(page.status, 200);
  assert.match(page.text, /ANTHROPIC_API_KEY/);
  const r = await planner.json(`/admin/events/${eventId}/ai/ask`, { q: 'How many guests?' });
  assert.equal(r.status, 400);
});

test('Ask AI sends wedding data to Claude Opus 5 without phones or ID numbers', async () => {
  AI._setClient(fake);
  reply('- 1 party attending (4 people)');
  const r = await planner.json(`/admin/events/${eventId}/ai/ask`, { q: 'How many are attending?' });
  assert.equal(r.status, 200);
  assert.match(r.body.answer, /4 people/);
  const req = calls.at(-1);
  assert.equal(req.model, 'claude-opus-5');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  const data = req.system.map((b) => b.text).join('\n');
  assert.match(data, /Verma Family/);
  assert.doesNotMatch(data, /9811112222/, 'phone numbers are not sent');
  assert.doesNotMatch(data, /999988887777/, 'ID numbers are not sent');
  assert.equal(req.system.at(-1).cache_control.type, 'ephemeral', 'wedding data is prompt-cached');

  // Other companies cannot query this wedding.
  assert.equal((await other.json(`/admin/events/${eventId}/ai/ask`, { q: 'x' })).status, 404);
});

test('AI status report is stored and shown; refusals are reported cleanly', async () => {
  reply(JSON.stringify({ headline: 'On track with 1 VIP pending', summary: 'Summary text.', risks: [{ title: 'IDs', detail: 'Missing' }],
    next_actions: ['Call Dr. Rao'], guest_experience_ideas: ['Welcome kit'] }));
  const r = await planner.post(`/admin/events/${eventId}/ai/summary`);
  assert.match(decodeURIComponent(r.location), /AI status report ready/);
  assert.equal(calls.at(-1).output_config.format.type, 'json_schema');
  const page = await planner.get(`/admin/events/${eventId}/insights`);
  assert.match(page.text, /On track with 1 VIP pending/);
  assert.match(page.text, /Call Dr. Rao/);

  replies.push({ stop_reason: 'refusal', content: [] });
  const bad = await planner.json(`/admin/events/${eventId}/ai/ask`, { q: 'something' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /declined/);
});

test('AI drafts a WhatsApp message with a send link', async () => {
  reply('Namaste Verma ji 🙏 …');
  const r = await planner.json(`/admin/guests/${guest.id}/ai/message`, { purpose: 'id_request', language: 'Hinglish' });
  assert.equal(r.status, 200);
  assert.match(r.body.wa, /^https:\/\/wa\.me\/919811112222\?text=/);
  assert.match(calls.at(-1).messages[0].content, /Hinglish/);
});

test('smart fill turns call notes into validated fields', async () => {
  const fn = db.prepare("SELECT id FROM functions WHERE event_id = ? AND name = 'Sangeet'").get(eventId);
  reply(JSON.stringify({ functions: [{ function_id: fn.id, rsvp: 'yes', pax: 3 }, { function_id: 99999, rsvp: 'yes', pax: 1 }],
    arrival_date: '2030-02-12', arrival_time: '9am', arrival_mode: 'Flight', arrival_details: '6E 234', arrival_point: null, pickup_required: true,
    departure_date: null, departure_time: null, departure_mode: 'Rocket', departure_number: null, drop_required: null, needs_stay: true,
    dietary: 'Jain', allergies: null, special_needs: 'Wheelchair for dadi', kids: 1, clean_note: 'Coming 3 for Sangeet.', suggested_follow_up: null }));
  const r = await planner.json(`/caller/guest/${guest.id}/ai/extract`, { notes: 'sangeet pe 3 log, 12 ko indigo 6E 234, jain, dadi ke liye wheelchair' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.functions, [{ function_id: fn.id, rsvp: 'yes', pax: 3 }], 'unknown function ids are dropped');
  assert.equal(r.body.arrival_time, null, 'badly formatted time is dropped');
  assert.equal(r.body.departure_mode, null, 'unknown travel mode is dropped');
  assert.equal(r.body.dietary, 'Jain');
  assert.equal(r.body.pickup_required, true);
});

test('app is installable: manifest, service worker and icons', async () => {
  const m = await fetch(`${ctx.base}/manifest.webmanifest`);
  assert.equal(m.status, 200);
  const manifest = await m.json();
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));
  assert.equal((await fetch(`${ctx.base}/sw.js`)).status, 200);
  assert.equal((await fetch(`${ctx.base}/static/icons/icon-192.png`)).status, 200);
  const page = await (await fetch(`${ctx.base}/login`)).text();
  assert.match(page, /rel="manifest"/);
});
