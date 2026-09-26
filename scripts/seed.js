// Fills the database with a realistic demo wedding so the app can be tried end to end.
// Usage: npm run seed        (adds a demo wedding + team; safe to run on an empty or existing database)
const db = require('../src/db');
const { hashPassword } = require('../src/auth');
const { token } = require('../src/util');

const now = Date.now();
const ago = (hours) => new Date(now - hours * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
const ahead = (hours) => ago(-hours);

db.exec('BEGIN');
try {
  // A partner event company using the free software…
  const partner = db.prepare("SELECT id FROM orgs WHERE name = 'Royal Knot Events (Demo)'").get()?.id
    ?? Number(db.prepare(`INSERT INTO orgs (name, contact_name, phone, email, city) VALUES
      ('Royal Knot Events (Demo)', 'Meera Jain', '9829000000', 'meera@royalknot.demo', 'Jaipur')`).run().lastInsertRowid);
  const user = (name, login, role, orgId) => {
    const found = db.prepare('SELECT id FROM users WHERE login = ?').get(login);
    if (found) return { id: found.id, name };
    const info = db.prepare('INSERT INTO users (name, login, role, pass_hash, org_id) VALUES (?,?,?,?,?)').run(name, login, role, hashPassword('demo123'), orgId);
    return { id: Number(info.lastInsertRowid), name };
  };
  user('Meera', 'meera@royalknot.demo', 'admin', partner);
  // …and Candid Dulhan's own RSVP-desk team, working on the partner's wedding.
  const team = [
    user('Neha', 'neha@demo.in', 'caller', db.platformOrgId),
    user('Ravi', 'ravi@demo.in', 'caller', db.platformOrgId),
    user('Priya', 'priya@demo.in', 'admin', db.platformOrgId),
  ];

  const clientToken = token(18);
  const log = db.prepare('INSERT INTO activities (event_id, guest_id, actor, kind, detail, created_at) VALUES (?,?,?,?,?,?)');
  const event = db.prepare(`INSERT INTO events (title, client_name, client_phone, event_date, venue, city, welcome_note,
    require_id, collect_travel, client_token, org_id, service_status, service_note, service_updated_at) VALUES (?,?,?,?,?,?,?,1,1,?,?, 'active', ?, datetime('now', '-4 days'))`).run(
    'Aarav & Diya (Demo)', 'Mrs. Sunita Sharma', '9876500000', '2026-12-12', 'The Leela Palace', 'Udaipur',
    'With the blessings of our families, we would be honoured by your presence as we begin our journey together.', clientToken,
    partner, '~450 guests, Hindi calls, all RSVPs by 20 Nov, rooming list for 2 hotels');
  const eventId = Number(event.lastInsertRowid);
  // A second partner wedding that has just asked for the RSVP desk (shows up in the platform pipeline).
  const second = Number(db.prepare(`INSERT INTO events (title, event_date, venue, city, client_token, org_id, service_status, service_note, service_updated_at)
    VALUES ('Kabir & Ananya (Demo)', '2027-01-20', 'Rambagh Palace', 'Jaipur', ?, ?, 'requested', '~300 guests, need calling + ID collection, deadline 5 Jan', datetime('now', '-2 hours'))`)
    .run(token(18), partner).lastInsertRowid);
  ['Nikhil Arora', 'Simran Kaur', 'Tarun Goyal'].forEach((n, i) => db.prepare('INSERT INTO guests (event_id, name, phone, max_pax, token) VALUES (?,?,?,2,?)')
    .run(second, n, `97${String(20000000 + i * 3456789).slice(0, 8)}`, token()));
  log.run(eventId, null, 'Meera', 'service', 'Requested the Candid Dulhan RSVP desk', ago(100));
  log.run(eventId, null, 'Priya', 'service', 'Candid Dulhan RSVP desk accepted — service is active', ago(98));


  const call = db.prepare(`INSERT INTO calls (event_id, guest_id, phone, caller, user_id, outcome, notes, duration_sec, source, called_at)
    VALUES (?,?,?,?,?,?,?,?, 'console', ?)`);
  log.run(eventId, null, 'Meera', 'import', 'Imported 24 guests from CSV', ago(96));

  // name, side, group, max_pax, status, pax, arrival, mode, stay, dietary, id, owner(0/1/null), followUpHours
  const guests = [
    ['Rajesh Sharma', 'Bride', 'Family', 4, 'yes', 4, '2026-12-10', 'Flight', 1, 'Vegetarian', 'Aadhaar', 0],
    ['Meena Gupta', 'Bride', 'Family', 3, 'yes', 3, '2026-12-11', 'Train', 1, 'Jain', 'Aadhaar', 0],
    ['Anil Kapoor', 'Groom', 'Friends', 2, 'maybe', 2, null, null, null, null, null, 1, -3],
    ['Sanjay Verma', 'Groom', 'Family', 5, 'yes', 5, '2026-12-10', 'Car', 1, 'Non-vegetarian', 'Passport', 1],
    ['Kavita Joshi', 'Bride', 'Friends', 2, 'no', 0, null, null, null, null, null, 0],
    ['Deepak Malhotra', 'Groom', 'Office', 2, 'pending', null, null, null, null, null, null, 1, 2],
    ['Pooja Iyer', 'Bride', 'Friends', 1, 'yes', 1, '2026-12-11', 'Flight', 1, 'Vegan', null, 0],
    ['Harish Mehta', 'Groom', 'Family', 4, 'pending', null, null, null, null, null, null, 1, -26],
    ['Sunil Bansal', 'Bride', 'Family', 3, 'pending', null, null, null, null, null, null, 0, 5],
    ['Ritu Agarwal', 'Bride', 'Office', 2, 'yes', 2, '2026-12-12', 'Local', 0, 'Vegetarian', 'Driving Licence', 0],
    ['Vikram Singh', 'Groom', 'Friends', 2, 'yes', 2, '2026-12-11', 'Flight', 1, 'Non-vegetarian', null, 1],
    ['Nisha Reddy', 'Groom', 'Friends', 1, 'pending', null, null, null, null, null, null, null],
    ['Arjun Nair', 'Groom', 'Office', 2, 'pending', null, null, null, null, null, null, null],
    ['Lata Deshpande', 'Bride', 'Family', 2, 'maybe', 2, null, null, null, null, null, 0, 20],
    ['Manoj Tiwari', 'Groom', 'Family', 6, 'yes', 6, '2026-12-10', 'Bus', 1, 'Vegetarian', 'Aadhaar', 1],
    ['Sneha Kulkarni', 'Bride', 'Friends', 2, 'pending', null, null, null, null, null, null, null],
    ['Rohit Chopra', 'Groom', 'Friends', 2, 'no', 0, null, null, null, null, null, 1],
    ['Geeta Pandey', 'Bride', 'Family', 3, 'yes', 3, '2026-12-11', 'Train', 1, 'Jain', 'Voter ID', 0],
    ['Amit Saxena', 'Groom', 'Office', 1, 'pending', null, null, null, null, null, null, null],
    ['Farah Khan', 'Bride', 'Friends', 2, 'yes', 2, '2026-12-12', 'Flight', 0, 'Non-vegetarian', null, 0],
    ['Suresh Rao', 'Groom', 'Family', 4, 'pending', null, null, null, null, null, null, 1, -1],
    ['Anjali Bose', 'Bride', 'Office', 2, 'pending', null, null, null, null, null, null, null],
    ['Karan Oberoi', 'Groom', 'Friends', 2, 'yes', 2, '2026-12-11', 'Flight', 1, 'Vegetarian', 'Passport', 1],
    ['Divya Menon', 'Bride', 'Friends', 1, 'pending', null, null, null, null, null, null, 0],
  ];

  guests.forEach(([name, side, group, maxPax, status, pax, arrival, mode, stay, dietary, idType, owner, followUp], i) => {
    const phone = `98${String(10000000 + i * 1234567).slice(0, 8)}`;
    const assignee = owner == null ? null : team[owner];
    const invitedAt = ago(90 - i);
    const responded = status !== 'pending' ? ago(70 - i * 2) : null;
    const info = db.prepare(`INSERT INTO guests (event_id, name, phone, side, group_name, max_pax, token, invited_at, rsvp_status, pax,
      arrival_date, arrival_mode, needs_stay, dietary, responded_at, id_type, id_number, id_consent_at, assigned_to, follow_up_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, name, phone, side, group, maxPax, token(), invitedAt, status,
      pax, arrival, mode, stay, dietary, responded, idType, idType ? String(400000000000 + i * 7919) : null, idType ? responded : null,
      assignee?.id ?? null, followUp == null ? null : ahead(followUp));
    const gid = Number(info.lastInsertRowid);
    log.run(eventId, gid, 'Meera', 'invite', 'WhatsApp invite sent', invitedAt);
    if (assignee) log.run(eventId, gid, 'Priya', 'assign', `Assigned to ${assignee.name} (auto-split)`, ago(80));
    if (status !== 'pending' && i % 3 !== 2) {
      log.run(eventId, gid, 'Guest', 'rsvp', `RSVP received: ${{ yes: 'Attending', no: 'Declined', maybe: 'Maybe' }[status]}${pax ? ` (${pax} ${pax === 1 ? 'person' : 'people'})` : ''}`, responded);
      if (idType) log.run(eventId, gid, 'Guest', 'id', `ID uploaded (${idType}) — demo, no file`, responded);
    }
    if (assignee && (status === 'pending' || i % 3 === 2)) {
      const outcome = status === 'pending' ? (i % 2 ? 'no_answer' : 'callback') : 'connected';
      const notes = { no_answer: '', callback: 'Asked to call back in the evening', connected: 'Confirmed on call' }[outcome];
      call.run(eventId, gid, phone, assignee.name, assignee.id, outcome, notes || null, outcome === 'connected' ? 140 : 0, ago(20 - i / 2));
      log.run(eventId, gid, assignee.name, 'call', `Call: ${{ no_answer: 'No answer', callback: 'Call back later', connected: 'Connected' }[outcome]}${notes ? ` — ${notes}` : ''}`, ago(20 - i / 2));
      if (status !== 'pending') log.run(eventId, gid, assignee.name, 'rsvp', `RSVP updated on call: ${{ yes: 'Attending', no: 'Declined', maybe: 'Maybe' }[status]}`, ago(20 - i / 2));
    }
  });
  db.exec('COMMIT');

  console.log(`
Demo data created (password for every login: demo123)

Partner event company: Royal Knot Events (Demo)
  Admin : meera@royalknot.demo   — owns "Aarav & Diya" (RSVP desk active) and "Kabir & Ananya" (RSVP desk requested)

Candid Dulhan (you)
  Admin : priya@demo.in           — platform dashboard, accepts service requests
  Caller: neha@demo.in, ravi@demo.in — work the partner wedding
  Owner : leave "Email or phone" empty, use ADMIN_PASSWORD

Client dashboard: /c/${clientToken}
`);
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
