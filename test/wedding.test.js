// Functions, per-function RSVP, family members, custom fields, rooming, and dedicated-staff access.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, idFrom } = require('./helpers');

const ctx = boot();
const { db } = ctx;
before(ctx.start);
after(ctx.stop);

let planner, owner, eventId, guest;

test('planner sets up functions, a custom question and a hotel', async () => {
  planner = ctx.client();
  await planner.post('/signup', { company: 'Shubh Events', name: 'Kiran', phone: '9100000001', email: 'kiran@shubh.test', password: 'secret1' });
  const r = await planner.post('/admin/events', { title: 'Riya & Dev', require_id: '1', collect_travel: '1' });
  eventId = idFrom(r.location);
  await planner.post(`/admin/events/${eventId}/guests`, { name: 'Mehta Family', phone: '9822222222', max_pax: '3' });
  guest = db.prepare('SELECT * FROM guests WHERE event_id = ?').get(eventId);
  await planner.post(`/admin/events/${eventId}/functions/defaults`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM guest_functions WHERE guest_id = ?').get(guest.id).n, 5, 'invited to all 5 functions');
  await planner.post(`/admin/events/${eventId}/fields`, { label: 'Performing at Sangeet?', type: 'yesno', on_rsvp: '1' });
  await planner.post(`/admin/events/${eventId}/hotels`, { name: 'Lake Palace', rooms_blocked: '20' });
  for (const p of ['functions', 'fields', 'rooming', 'transport']) {
    assert.equal((await planner.get(`/admin/events/${eventId}/${p}`)).status, 200, p);
  }
});

test('guest answers per function, names family members with IDs and answers custom questions', async () => {
  const fns = db.prepare('SELECT * FROM functions WHERE event_id = ? ORDER BY sort').all(eventId);
  const cf = db.prepare('SELECT * FROM custom_fields WHERE event_id = ?').get(eventId);
  let page = await ctx.client().get(`/i/${guest.token}`);
  assert.match(page.text, /Sangeet/);
  assert.match(page.text, /Performing at Sangeet\?/);

  const form = new FormData();
  fns.forEach((f, i) => { form.append(`fn_${f.id}`, i === 0 ? 'no' : 'yes'); form.append(`fn_pax_${f.id}`, '9'); });
  form.append('m_0_name', 'Sunita Mehta'); form.append('m_0_relation', 'Wife'); form.append('m_0_age', 'Adult'); form.append('m_0_idtype', 'Aadhaar');
  form.append('m_0_file', new Blob(['img'], { type: 'image/png' }), 'id.png');
  form.append('m_1_name', 'Aryan'); form.append('m_1_age', 'Child');
  form.append('arrival_date', '2026-12-10'); form.append('arrival_time', '14:30'); form.append('arrival_mode', 'Flight');
  form.append('arrival_details', '6E 2134'); form.append('pickup_required', '1'); form.append('needs_stay', '1');
  form.append(`cf_${cf.id}`, 'Yes');

  let r = await ctx.client().post(`/i/${guest.token}`, form);
  assert.equal(r.status, 400, 'ID upload without consent is refused');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM guest_members WHERE guest_id = ?').get(guest.id).n, 0);

  form.append('id_consent', '1');
  r = await ctx.client().post(`/i/${guest.token}`, form);
  assert.equal(r.status, 302);
  const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(guest.id);
  assert.equal(g.rsvp_status, 'yes');
  assert.equal(g.pax, 3, 'pax capped at invited count');
  assert.equal(g.arrival_time, '14:30');
  assert.equal(g.pickup_required, 1);
  const answers = db.prepare('SELECT rsvp FROM guest_functions gf JOIN functions f ON f.id = gf.function_id WHERE gf.guest_id = ? ORDER BY f.sort').all(guest.id).map((a) => a.rsvp);
  assert.deepEqual(answers, ['no', 'yes', 'yes', 'yes', 'yes']);
  const members = db.prepare('SELECT * FROM guest_members WHERE guest_id = ? ORDER BY sort').all(guest.id);
  assert.deepEqual(members.map((m) => m.name), ['Sunita Mehta', 'Aryan']);
  assert.ok(members[0].id_file, 'member ID stored');
  assert.equal(db.prepare('SELECT value FROM guest_custom WHERE guest_id = ?').get(guest.id).value, 'Yes');

  const stats = await planner.get(`/admin/events/${eventId}`);
  assert.match(stats.text, /Functions/);
  r = await planner.get(`/admin/events/${eventId}/transport`);
  assert.match(r.text, /6E 2134/);
});

test('planner assigns a room; rooming list and client CSV export', async () => {
  const hotel = db.prepare('SELECT id FROM hotels WHERE event_id = ?').get(eventId);
  await planner.post(`/admin/guests/${guest.id}/room`, { hotel_id: String(hotel.id), room_type: 'Triple', room_no: '204' });
  let r = await planner.get(`/admin/events/${eventId}/rooming.csv`);
  assert.match(r.text, /Lake Palace,Triple,204,Mehta Family/);
  assert.match(r.text, /Sunita Mehta/);

  await planner.post(`/admin/guests/${guest.id}`, { name: 'Mehta Family', max_pax: '3', internal_notes: 'SECRET-NOTE' });
  const e = db.prepare('SELECT client_token FROM events WHERE id = ?').get(eventId);
  r = await ctx.client().get(`/c/${e.client_token}/export.csv`);
  assert.doesNotMatch(r.text, /SECRET-NOTE/, 'internal notes are not shown to the client');
  r = await planner.get(`/admin/events/${eventId}/export.csv`);
  assert.match(r.text, /SECRET-NOTE/);
  r = await ctx.client().get(`/c/${e.client_token}?tab=rooming`);
  assert.match(r.text, /Lake Palace/);
});

test('only Candid Dulhan staff dedicated to a wedding can work on it', async () => {
  owner = ctx.client();
  await owner.post('/login', { password: 'owner-pass', name: 'Owner' });
  await owner.post('/admin/team', { name: 'Neha', login: 'neha@cd.test', role: 'caller', password: 'nehapass' });
  await owner.post('/admin/team', { name: 'Ravi', login: 'ravi@cd.test', role: 'caller', password: 'ravipass' });
  const neha = db.prepare("SELECT id FROM users WHERE login = 'neha@cd.test'").get().id;

  await planner.post(`/admin/events/${eventId}/service`, { action: 'request', note: 'Need 1 person' });
  await owner.post(`/admin/platform/events/${eventId}`, { action: 'accept', staff: String(neha) });

  const nehaC = ctx.client(); await nehaC.post('/login', { login: 'neha@cd.test', password: 'nehapass' });
  const raviC = ctx.client(); await raviC.post('/login', { login: 'ravi@cd.test', password: 'ravipass' });
  assert.equal((await nehaC.get(`/caller/${eventId}`)).status, 200, 'assigned staff can work the wedding');
  assert.equal((await raviC.get(`/caller/${eventId}`)).status, 404, 'unassigned staff cannot');
  assert.doesNotMatch((await raviC.get('/caller')).text, /Riya &amp; Dev/);

  let r = await planner.get(`/admin/events/${eventId}`);
  assert.match(r.text, /dedicated guest managers: <strong>Neha<\/strong>/);
  // Neha appears in the planner's assignable team for this wedding.
  assert.match(r.text, new RegExp(`<option value="${neha}">Neha</option>`));

  // Planner ends the service: Neha loses access.
  await planner.post(`/admin/events/${eventId}/service`, { action: 'end' });
  assert.equal((await nehaC.get(`/caller/${eventId}`)).status, 404);
});
