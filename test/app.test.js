// End-to-end tests: boots the app on a temp database and drives it over HTTP.
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsvp-test-'));
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'owner-pass';
process.env.API_KEY = 'test-key';

const app = require('../src/server');
const db = require('../src/db');
let server, base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

// Tiny cookie-keeping client.
function client() {
  let cookie = '';
  const req = async (method, url, form) => {
    const res = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) {
      const [pair] = c.split(';');
      const [k] = pair.split('=');
      cookie = [...cookie.split('; ').filter((x) => x && !x.startsWith(`${k}=`)), pair].join('; ');
    }
    return { status: res.status, location: res.headers.get('location') || '', text: await res.text() };
  };
  return { get: (u) => req('GET', u), post: (u, f = {}) => req('POST', u, f) };
}

const idFrom = (loc) => Number(/\/events\/(\d+)/.exec(loc)?.[1]);

let owner, acme, bloom, acmeEvent, bloomEvent, acmeGuest;

test('event companies can sign up and get their own workspace', async () => {
  acme = client();
  let r = await acme.post('/signup', { company: 'Acme Events', name: 'Asha', phone: '9000000001', email: 'asha@acme.test', password: 'secret1' });
  assert.equal(r.status, 302);
  bloom = client();
  r = await bloom.post('/signup', { company: 'Bloom Weddings', name: 'Bina', phone: '9000000002', password: 'secret2' });
  assert.equal(r.status, 302);
  r = await client().post('/signup', { company: 'Dup', name: 'X', phone: '1', email: 'asha@acme.test', password: 'secret3' });
  assert.equal(r.status, 400, 'duplicate login is rejected');

  r = await acme.post('/admin/events', { title: 'Acme Wedding' });
  acmeEvent = idFrom(r.location);
  r = await bloom.post('/admin/events', { title: 'Bloom Wedding' });
  bloomEvent = idFrom(r.location);
  assert.ok(acmeEvent && bloomEvent);
  await acme.post(`/admin/events/${acmeEvent}/guests`, { name: 'Guest A', phone: '9811111111', max_pax: '2' });
  acmeGuest = db.prepare('SELECT id FROM guests WHERE event_id = ?').get(acmeEvent).id;
});

test('a company cannot see or touch another company’s weddings, guests or team', async () => {
  let r = await bloom.get('/admin');
  assert.match(r.text, /Bloom Wedding/);
  assert.doesNotMatch(r.text, /Acme Wedding/);
  for (const url of [`/admin/events/${acmeEvent}`, `/admin/events/${acmeEvent}/export.csv`, `/admin/guests/${acmeGuest}`,
    `/caller/${acmeEvent}`, `/caller/guest/${acmeGuest}`, '/admin/platform', '/admin/unmatched']) {
    r = await bloom.get(url);
    assert.equal(r.status, 404, `bloom GET ${url}`);
  }
  r = await bloom.post(`/admin/guests/${acmeGuest}/delete`);
  assert.equal(r.status, 404);
  r = await bloom.post(`/admin/events/${acmeEvent}/delete`);
  assert.equal(r.status, 404);
  assert.ok(db.prepare('SELECT 1 FROM events WHERE id = ?').get(acmeEvent), 'acme wedding still exists');
  r = await bloom.get('/admin/team');
  assert.doesNotMatch(r.text, /Asha/);
});

test('Candid Dulhan only gets access once the RSVP desk service is active', async () => {
  owner = client();
  await owner.post('/login', { password: 'owner-pass', name: 'Owner' });
  let r = await owner.get(`/admin/events/${acmeEvent}`);
  assert.equal(r.status, 404, 'no access before service');

  r = await acme.post(`/admin/events/${acmeEvent}/service`, { action: 'request', note: '200 guests, Hindi' });
  assert.equal(r.status, 302);
  r = await owner.get('/admin/platform');
  assert.match(r.text, /Acme Wedding/);
  assert.match(r.text, /200 guests, Hindi/);
  r = await owner.get(`/admin/events/${acmeEvent}`);
  assert.equal(r.status, 404, 'still no access while only requested');

  await owner.post(`/admin/platform/events/${acmeEvent}`, { action: 'accept' });
  r = await owner.get(`/admin/events/${acmeEvent}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Partner wedding/);
  r = await owner.post(`/admin/events/${acmeEvent}/delete`);
  assert.match(r.location, /Only%20the%20company/, 'platform cannot delete a partner wedding');
  r = await owner.get(`/caller/guest/${acmeGuest}`);
  assert.equal(r.status, 200, 'CD callers can work the guest');

  // Android recordings match guests on served weddings.
  const fd = new FormData();
  fd.append('file', new Blob(['audio'], { type: 'audio/mp4' }), 'call.m4a');
  fd.append('phone', '+91 98111 11111');
  const up = await fetch(`${base}/api/recordings`, { method: 'POST', headers: { 'x-api-key': 'test-key' }, body: fd }).then((x) => x.json());
  assert.equal(up.matched, true);

  await acme.post(`/admin/events/${acmeEvent}/service`, { action: 'end' });
  r = await owner.get(`/admin/events/${acmeEvent}`);
  assert.equal(r.status, 404, 'access revoked when service ends');
});

test('guest RSVP and client dashboard are co-branded with the event company', async () => {
  const g = db.prepare('SELECT token FROM guests WHERE id = ?').get(acmeGuest);
  let r = await client().get(`/i/${g.token}`);
  assert.match(r.text, /Guest management by <strong>Acme Events<\/strong>/);
  r = await client().post(`/i/${g.token}`, { rsvp_status: 'yes', pax: '5' });
  assert.equal(r.status, 302);
  assert.equal(db.prepare('SELECT pax FROM guests WHERE id = ?').get(acmeGuest).pax, 2, 'pax capped at invited count');
  const e = db.prepare('SELECT client_token FROM events WHERE id = ?').get(acmeEvent);
  r = await client().get(`/c/${e.client_token}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Acme Events/);
});

test('team accounts stay inside their company', async () => {
  await bloom.post('/admin/team', { name: 'Bob', login: 'bob@bloom.test', role: 'caller', password: 'bobpass' });
  const bob = client();
  await bob.post('/login', { login: 'bob@bloom.test', password: 'bobpass' });
  let r = await bob.get('/caller');
  assert.match(r.text, /Bloom Wedding/);
  assert.doesNotMatch(r.text, /Acme Wedding/);
  r = await bob.get('/admin');
  assert.equal(r.status, 302, 'callers cannot open admin');
  // Acme cannot edit Bloom's users.
  const bobId = db.prepare("SELECT id FROM users WHERE login = 'bob@bloom.test'").get().id;
  r = await acme.post(`/admin/team/${bobId}`, { role: 'admin', active: '1' });
  assert.equal(r.status, 404);
});
