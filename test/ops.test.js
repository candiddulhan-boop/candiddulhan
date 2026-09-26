// Bulk upload, ID vault, WhatsApp (test mode + webhook) and automation.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { boot, idFrom } = require('./helpers');

const ctx = boot();
const { db } = ctx;
before(ctx.start);
after(ctx.stop);

// Cookie-keeping client that can send forms, JSON and multipart.
function client() {
  let cookie = '';
  const keep = (res) => { for (const c of res.headers.getSetCookie?.() || []) { const [p] = c.split(';'); const [k] = p.split('='); cookie = [...cookie.split('; ').filter((x) => x && !x.startsWith(`${k}=`)), p].join('; '); } };
  const go = async (method, url, body, type) => {
    const res = await fetch(ctx.base + url, { method, redirect: 'manual', headers: { cookie, ...(type ? { 'content-type': type } : {}) }, body });
    keep(res);
    return { status: res.status, location: res.headers.get('location') || '', buf: Buffer.from(await res.arrayBuffer()) };
  };
  return {
    get: (u) => go('GET', u).then((r) => ({ ...r, text: r.buf.toString() })),
    post: (u, f = {}) => go('POST', u, new URLSearchParams(f).toString(), 'application/x-www-form-urlencoded'),
    multipart: (u, fd) => go('POST', u, fd),
  };
}
const msg = (r) => decodeURIComponent((/msg=([^&]*)/.exec(r.location) || [])[1] || '');

let owner, partner, ownEvent, partnerEvent;

test('setup: Candid Dulhan wedding with functions, and a partner company', async () => {
  owner = client();
  await owner.post('/login', { password: 'owner-pass', name: 'Owner' });
  let r = await owner.post('/admin/events', { title: 'Tara & Vir', event_date: '2030-03-10', require_id: '1', collect_travel: '1' });
  ownEvent = idFrom(r.location);
  await owner.post(`/admin/events/${ownEvent}/functions/defaults`);
  partner = client();
  await partner.post('/signup', { company: 'Mangal Events', name: 'Mona', phone: '9400000001', email: 'mona@mangal.test', password: 'secret1' });
  r = await partner.post('/admin/events', { title: 'Partner Wedding' });
  partnerEvent = idFrom(r.location);
});

test('bulk upload from Excel adds, then updates by mobile; CSV works too; other companies are blocked', async () => {
  const tpl = await owner.get(`/admin/events/${ownEvent}/import-template.xlsx`);
  assert.equal(tpl.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(tpl.buf);
  const ws = wb.getWorksheet('Guests');
  const header = ws.getRow(1).values.slice(1);
  const row = (o) => header.map((h) => o[h] ?? '');
  ws.addRow(row({ Name: 'Kapoor Family', 'Mobile (WhatsApp)': '+91 98100 22222', Side: 'groom', Category: 'VIP', 'Invited for (people)': 3,
    Functions: 'Sangeet, Wedding', 'Family members': 'Neha (Wife); Tia (Daughter, Child)', 'Arrival date': '12/03/2030', 'Needs accommodation': 'yes', Hotel: 'Lake Palace' }));
  ws.addRow(row({ Name: 'Short Number', 'Mobile (WhatsApp)': '12345' }));
  const fd = new FormData();
  fd.append('update', '1');
  fd.append('file', new Blob([await wb.xlsx.writeBuffer()]), 'guests.xlsx');
  let r = await owner.multipart(`/admin/events/${ownEvent}/import`, fd);
  assert.match(msg(r), /1 added, 0 updated, 2 family members, 1 new hotels, 3 skipped/); // 2 example rows + short number
  const g = db.prepare("SELECT * FROM guests WHERE name = 'Kapoor Family'").get();
  assert.equal(g.side, 'Groom');
  assert.equal(g.arrival_date, '2030-03-12', 'DD/MM/YYYY is read Indian-style');
  assert.equal(g.needs_stay, 1);
  assert.ok(g.hotel_id);
  const fns = db.prepare('SELECT f.name FROM guest_functions gf JOIN functions f ON f.id = gf.function_id WHERE gf.guest_id = ? ORDER BY f.sort').all(g.id).map((x) => x.name);
  assert.deepEqual(fns, ['Sangeet', 'Wedding']);

  const csv = new FormData();
  csv.append('update', '1');
  csv.append('file', new Blob(['Name,Mobile,Food preference\nKapoor Family,9810022222,Jain\nNew Guest,9000011111,\n']), 'g.csv');
  r = await owner.multipart(`/admin/events/${ownEvent}/import`, csv);
  assert.match(msg(r), /1 added, 1 updated/);
  assert.equal(db.prepare('SELECT dietary FROM guests WHERE id = ?').get(g.id).dietary, 'Jain');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM guests WHERE event_id = ?').get(ownEvent).n, 2);

  const other = new FormData();
  other.append('file', new Blob(['Name\nX\n']), 'x.csv');
  assert.equal((await partner.multipart(`/admin/events/${ownEvent}/import`, other)).status, 404);
});

test('ID vault: Aadhaar kept as last 4 digits, PAN validated, files encrypted on disk, views logged, purge deletes', async () => {
  db.prepare("UPDATE events SET extra_docs = 'PAN' WHERE id = ?").run(ownEvent);
  const g = db.prepare("SELECT * FROM guests WHERE name = 'Kapoor Family'").get();
  const fn = db.prepare('SELECT function_id FROM guest_functions WHERE guest_id = ?').all(g.id);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(64)]);
  const form = (pan) => {
    const f = new FormData();
    fn.forEach((x) => f.append(`fn_${x.function_id}`, 'yes'));
    f.append('id_type', 'Aadhaar'); f.append('id_number', '1234 5678 9012'); f.append('id_consent', '1');
    f.append('id_file', new Blob([png], { type: 'image/png' }), 'aadhaar.png');
    f.append('doc_PAN_num', pan);
    return f;
  };
  let r = await client().multipart(`/i/${g.token}`, form('BADPAN'));
  assert.equal(r.status, 400, 'invalid PAN is rejected');
  assert.match(r.buf.toString(), /PAN should look like ABCDE1234F/);
  r = await client().multipart(`/i/${g.token}`, form('abcde1234f'));
  assert.equal(r.status, 302);
  const saved = db.prepare('SELECT * FROM guests WHERE id = ?').get(g.id);
  assert.equal(saved.id_number, 'XXXXXXXX9012', 'only the last 4 Aadhaar digits are stored');
  assert.match(saved.id_file, /\.enc$/);
  const onDisk = fs.readFileSync(path.join(process.env.DATA_DIR, 'uploads', 'ids', saved.id_file));
  assert.ok(!onDisk.includes(png.subarray(8, 40)), 'file content is encrypted on disk');
  const pan = db.prepare("SELECT * FROM id_documents WHERE guest_id = ? AND doc_type = 'PAN'").get(g.id);
  assert.equal(pan.number, 'ABCDE1234F');

  const view = await owner.get(`/admin/guests/${g.id}/id-file`);
  assert.deepEqual(view.buf, png, 'authorised download returns the original file');
  assert.ok(db.prepare("SELECT 1 FROM activities WHERE guest_id = ? AND kind = 'id_view' AND actor = 'Owner'").get(g.id), 'view is logged');
  assert.equal((await partner.get(`/admin/guests/${g.id}/id-file`)).status, 404);

  r = await owner.post(`/admin/events/${ownEvent}/purge-ids`);
  assert.match(msg(r), /Deleted \d+ ID files/);
  assert.equal(db.prepare('SELECT id_file FROM guests WHERE id = ?').get(g.id).id_file, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM id_documents').get().n, 0);
  assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR, 'uploads', 'ids', saved.id_file)));
});

test('WhatsApp in test mode: campaign, delivery receipts and reply buttons update RSVPs', async () => {
  const guest = db.prepare("SELECT * FROM guests WHERE name = 'New Guest'").get();
  let r = await owner.post(`/admin/events/${ownEvent}/whatsapp/send`, { purpose: 'reminder', audience: 'pending' });
  assert.match(msg(r), /Test mode: recorded 1 message/);
  const m = db.prepare("SELECT * FROM wa_messages WHERE guest_id = ? AND purpose = 'reminder'").get(guest.id);
  assert.equal(m.status, 'simulated');
  assert.match(m.body, /gentle reminder/);

  // Partner weddings can't bulk-send without the RSVP desk.
  r = await partner.post(`/admin/events/${partnerEvent}/whatsapp/send`, { purpose: 'reminder', audience: 'all' });
  assert.match(msg(r), /needs the Candid Dulhan RSVP desk/);

  const hook = (body, headers = {}) => fetch(`${ctx.base}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  // Delivery receipt, then an out-of-order "sent" that must not downgrade it.
  await hook({ entry: [{ changes: [{ value: { statuses: [{ id: m.wa_id, status: 'read' }] } }] }] });
  await hook({ entry: [{ changes: [{ value: { statuses: [{ id: m.wa_id, status: 'sent' }] } }] }] });
  await new Promise((ok) => setTimeout(ok, 100));
  assert.equal(db.prepare('SELECT status FROM wa_messages WHERE id = ?').get(m.id).status, 'read');

  // Guest taps "Yes, attending".
  await hook({ entry: [{ changes: [{ value: { messages: [{ from: '919000011111', id: 'wamid.1', type: 'button', button: { text: 'Yes, attending', payload: `rsvp:yes:${guest.token}` } }] } }] }] });
  await new Promise((ok) => setTimeout(ok, 150));
  const after = db.prepare('SELECT * FROM guests WHERE id = ?').get(guest.id);
  assert.equal(after.rsvp_status, 'yes');
  const answers = db.prepare('SELECT DISTINCT rsvp FROM guest_functions WHERE guest_id = ?').all(guest.id).map((x) => x.rsvp);
  assert.deepEqual(answers, ['yes'], 'every invited function marked attending');
  assert.ok(db.prepare("SELECT 1 FROM wa_messages WHERE guest_id = ? AND direction = 'out' AND purpose = 'reply'").get(guest.id), 'auto-reply sent');

  // Free text lands in the inbox; test-mode "Please call me" creates a follow-up.
  await hook({ entry: [{ changes: [{ value: { messages: [{ from: '919000011111', id: 'wamid.2', type: 'text', text: { body: 'Coming with parents!' } }] } }] }] });
  await new Promise((ok) => setTimeout(ok, 100));
  const page = await owner.get(`/admin/events/${ownEvent}/whatsapp`);
  assert.match(page.text, /Coming with parents!/);
  await owner.post(`/admin/guests/${guest.id}/wa/simulate`, { answer: 'call' });
  assert.ok(db.prepare('SELECT follow_up_at FROM guests WHERE id = ?').get(guest.id).follow_up_at);
});

test('WhatsApp webhook: verification handshake and signature check', async () => {
  process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
  let r = await fetch(`${ctx.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
  assert.equal(await r.text(), '42');
  r = await fetch(`${ctx.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`);
  assert.equal(r.status, 403);
  process.env.WHATSAPP_APP_SECRET = 'app-secret';
  const body = JSON.stringify({ entry: [] });
  r = await fetch(`${ctx.base}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(r.status, 401, 'unsigned webhook rejected');
  const sig = `sha256=${crypto.createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
  r = await fetch(`${ctx.base}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
  assert.equal(r.status, 200);
  delete process.env.WHATSAPP_APP_SECRET;
  delete process.env.WHATSAPP_VERIFY_TOKEN;
});

test('automation: reminders, no repeats the same day, escalation to callers, ID auto-delete', async () => {
  await owner.post('/admin/team', { name: 'Kiran', login: 'kiran@cd.test', role: 'caller', password: 'kiranpass' });
  db.prepare("INSERT INTO guests (event_id, name, phone, token, invited_at) VALUES (?, 'Silent Singh', '9555500001', 'tok-silent', datetime('now', '-10 days'))").run(ownEvent);
  const silent = db.prepare("SELECT * FROM guests WHERE token = 'tok-silent'").get();
  let r = await owner.post(`/admin/events/${ownEvent}/automation`, { on_rsvp_reminders: '1', rsvp_reminders_every: '2', rsvp_reminders_max: '3',
    on_escalate_to_callers: '1', escalate_to_callers_after: '1', on_auto_assign: '1' });
  assert.match(msg(r), /Automation saved/);
  r = await owner.post(`/admin/events/${ownEvent}/automation/run`);
  assert.match(msg(r), /Sent 1 RSVP reminders/);
  assert.match(msg(r), /Escalated 1 silent guests/);
  const s = db.prepare('SELECT * FROM guests WHERE id = ?').get(silent.id);
  assert.ok(s.follow_up_at, 'call follow-up created');
  assert.equal(db.prepare('SELECT name FROM users WHERE id = ?').get(s.assigned_to).name, 'Kiran');
  r = await owner.post(`/admin/events/${ownEvent}/automation/run`);
  assert.doesNotMatch(msg(r), /RSVP reminders/, 'no second reminder the same day');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM wa_messages WHERE guest_id = ? AND purpose = 'reminder'").get(silent.id).n, 1);

  // Retention: wedding long over, IDs deleted automatically.
  db.prepare("UPDATE events SET event_date = date('now', '-40 days'), id_retention_days = 30 WHERE id = ?").run(ownEvent);
  db.prepare("UPDATE functions SET date = date('now', '-40 days') WHERE event_id = ?").run(ownEvent);
  db.prepare("UPDATE guests SET id_type = 'PAN', id_number = 'ABCDE1234F' WHERE id = ?").run(silent.id);
  await owner.post(`/admin/events/${ownEvent}/automation`, { on_id_retention: '1' });
  r = await owner.post(`/admin/events/${ownEvent}/automation/run`);
  assert.equal(db.prepare('SELECT id_number FROM guests WHERE id = ?').get(silent.id).id_number, null);
  const page = await owner.get(`/admin/events/${ownEvent}/automation`);
  assert.match(page.text, /What automation did/);
});
