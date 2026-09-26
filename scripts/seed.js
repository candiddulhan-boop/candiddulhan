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

  // Functions, hotels, dedicated staff and a custom field for the served wedding.
  const fnIds = [['Haldi', '2026-12-10', '10:00', 'Poolside Lawn', 'Yellow'], ['Mehndi', '2026-12-10', '16:00', 'Courtyard', 'Green & pink'],
    ['Sangeet', '2026-12-11', '19:30', 'Grand Ballroom', 'Indo-western'], ['Wedding', '2026-12-12', '18:00', 'Lake Terrace', 'Traditional'],
    ['Reception', '2026-12-13', '20:00', 'Grand Ballroom', 'Formal']].map(([n, d, t, v, dc], i) =>
    Number(db.prepare('INSERT INTO functions (event_id, name, date, time, venue, dress_code, sort) VALUES (?,?,?,?,?,?,?)').run(eventId, n, d, t, v, dc, i + 1).lastInsertRowid));
  const hotelIds = [['The Leela Palace', 60], ['Taj Fateh Prakash', 25]].map(([n, rooms]) =>
    Number(db.prepare('INSERT INTO hotels (event_id, name, rooms_blocked) VALUES (?,?,?)').run(eventId, n, rooms).lastInsertRowid));
  db.prepare("INSERT INTO custom_fields (event_id, label, type, options, on_rsvp) VALUES (?, 'Performing at Sangeet?', 'yesno', NULL, 1)").run(eventId);
  db.prepare("INSERT INTO custom_fields (event_id, label, type, options, on_rsvp) VALUES (?, 'Kurta size', 'select', 'S, M, L, XL, XXL', 0)").run(eventId);
  for (const u of team.slice(0, 2)) db.prepare('INSERT OR IGNORE INTO event_staff (event_id, user_id) VALUES (?,?)').run(eventId, u.id);
  const relations = ['Mama ji', 'Bua', 'College friend', 'Chacha ji', 'Office colleague', 'Neighbour', 'Mausi'];
  const times = ['09:40', '11:15', '13:30', '15:05', '17:45', '20:10'];

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
    // Rich profile fields
    db.prepare(`UPDATE guests SET salutation = ?, relation = ?, city = ?, category = ?, language = 'Hindi',
      arrival_time = ?, arrival_details = ?, arrival_point = ?, pickup_required = ?, pickup_status = ?, pickup_vehicle = ?,
      departure_date = CASE WHEN ? THEN '2026-12-14' END, departure_time = CASE WHEN ? THEN '12:30' END, drop_required = ?,
      hotel_id = ?, room_type = ?, room_no = ?, kids = ? WHERE id = ?`).run(
      /^(Meena|Kavita|Pooja|Ritu|Nisha|Lata|Sneha|Geeta|Farah|Anjali|Divya)/.test(name) ? 'Mrs.' : 'Mr.', relations[i % relations.length], ['Delhi', 'Mumbai', 'Jaipur', 'Kolkata', 'Indore'][i % 5],
      i % 7 === 0 ? 'VIP' : group === 'Family' ? 'Family' : group === 'Office' ? 'Office' : 'Friends',
      arrival ? times[i % times.length] : null, mode === 'Flight' ? `6E ${2100 + i}` : mode === 'Train' ? `12${900 + i}` : null,
      mode === 'Flight' ? 'Udaipur Airport' : mode === 'Train' ? 'Udaipur City Station' : null,
      arrival && mode !== 'Local' && mode !== 'Car' ? 1 : arrival ? 0 : null,
      arrival && i % 4 === 0 ? 'Assigned' : arrival ? 'Pending' : null, arrival && i % 4 === 0 ? `Innova RJ27 ${1000 + i} · Ramesh 98290 1${i}` : null,
      arrival ? 1 : 0, arrival ? 1 : 0, arrival ? 1 : null,
      stay && i % 2 === 0 ? hotelIds[i % 2 === 0 && i % 4 === 0 ? 0 : 1] : null, stay ? (maxPax > 2 ? 'Triple' : 'Double') : null,
      stay && i % 2 === 0 ? String(300 + i) : null, maxPax > 3 ? 1 : 0, gid);
    // Per-function answers follow the overall status
    fnIds.forEach((fid, k) => {
      const a = status === 'yes' ? (k === 0 && i % 3 === 0 ? 'no' : 'yes') : status === 'no' ? 'no' : status === 'maybe' ? (k < 2 ? 'maybe' : 'yes') : 'pending';
      db.prepare('INSERT INTO guest_functions (guest_id, function_id, rsvp, pax) VALUES (?,?,?,?)').run(gid, fid, a, a === 'yes' ? pax || maxPax : a === 'no' ? 0 : null);
    });
    if (status === 'yes' && maxPax > 1) {
      ['Spouse', 'Son', 'Daughter', 'Mother'].slice(0, Math.min(maxPax - 1, 3)).forEach((rel, k) =>
        db.prepare('INSERT INTO guest_members (guest_id, name, relation, age_group, id_type, id_number, sort) VALUES (?,?,?,?,?,?,?)')
          .run(gid, `${name.split(' ')[1] || ''} ${['Sunita', 'Aryan', 'Kiara', 'Kamla'][k]}`.trim(), rel, rel === 'Mother' ? 'Senior' : k ? 'Child' : 'Adult',
            k === 0 ? 'Aadhaar' : null, k === 0 ? String(500000000000 + i * 131) : null, k));
    }
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
