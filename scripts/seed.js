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
      pax, arrival, mode, stay, dietary, responded, idType, idType ? require('../src/vault').checkNumber(idType === 'Aadhaar' ? 'Aadhaar' : 'Other', String(400000000000 + i * 7919)).value : null, idType ? responded : null,
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
            k === 0 ? 'Aadhaar' : null, k === 0 ? `XXXXXXXX${String(500000000000 + i * 131).slice(-4)}` : null, k));
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
  // WhatsApp history (as sent in test mode), PAN collection and automation rules for the demo wedding.
  require('../src/whatsapp');
  require('../src/automation');
  db.prepare("UPDATE events SET extra_docs = 'PAN', id_retention_days = 30 WHERE id = ?").run(eventId);
  const all = db.prepare('SELECT * FROM guests WHERE event_id = ? ORDER BY id').all(eventId);
  const camp = (purpose, audience, hoursAgo, list, statusOf) => {
    const cid = Number(db.prepare("INSERT INTO wa_campaigns (event_id, purpose, audience, total, source, created_by, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(eventId, purpose, audience, list.length, audience === 'auto' ? 'auto' : 'manual', audience === 'auto' ? 'Automation' : 'Meera', ago(hoursAgo)).lastInsertRowid);
    list.forEach((g, i) => db.prepare(`INSERT INTO wa_messages (event_id, guest_id, campaign_id, direction, purpose, body, phone, wa_id, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(eventId, g.id, cid, 'out', purpose,
      purpose === 'invite' ? `Namaste ${g.name} 🙏 With great joy, Royal Knot Events (Demo) invite you to the wedding of Aarav & Diya (Demo) on 12 Dec 2026 at The Leela Palace, Udaipur. Please confirm your presence using the button below.`
        : `Namaste ${g.name}, a gentle reminder to confirm your attendance for the wedding of Aarav & Diya (Demo) on 12 Dec 2026 at The Leela Palace, Udaipur. Please tap a button below to reply.`,
      `91${g.phone}`, `sim-seed-${cid}-${i}`, statusOf(i), ago(hoursAgo)));
  };
  camp('invite', 'not_invited', 90, all, (i) => (i % 5 === 0 ? 'delivered' : 'read'));
  const pendingNow = all.filter((g) => g.rsvp_status === 'pending');
  camp('reminder', 'auto', 20, pendingNow, (i) => (i % 3 === 0 ? 'delivered' : i % 4 === 0 ? 'failed' : 'read'));
  const inbound = (g, text, hoursAgo) => db.prepare(`INSERT INTO wa_messages (event_id, guest_id, direction, body, phone, wa_id, status, created_at)
    VALUES (?,?,?,?,?,?, 'received', ?)`).run(eventId, g.id, 'in', text, `91${g.phone}`, `sim-in-${g.id}-${hoursAgo}`, ago(hoursAgo));
  const byName = (n) => all.find((g) => g.name === n);
  inbound(byName('Farah Khan'), 'Yes, attending', 60);
  inbound(byName('Anil Kapoor'), 'Please call me', 18);
  inbound(byName('Sneha Kulkarni'), 'Will confirm after checking flights 🙏', 5);
  for (const [rule, cfg] of [['rsvp_reminders', { every: 3, max: 3 }], ['escalate_to_callers', { after: 3 }], ['auto_assign', {}],
    ['id_requests', { every: 4, max: 3 }], ['itinerary', { days: 2 }], ['daily_digest', { hour: 9 }], ['id_retention', {}]]) {
    db.prepare("INSERT OR REPLACE INTO automations (event_id, rule, enabled, config, last_run_at) VALUES (?,?,1,?, datetime('now', '-2 hours'))").run(eventId, rule, JSON.stringify(cfg));
  }
  const autoLog = db.prepare("INSERT INTO activities (event_id, guest_id, actor, kind, detail, created_at) VALUES (?,?,?,?,?,?)");
  autoLog.run(eventId, null, 'Automation', 'auto', `Sent ${pendingNow.length} RSVP reminders on WhatsApp`, ago(20));
  autoLog.run(eventId, null, 'Automation', 'auto', 'Daily summary sent to the planner on WhatsApp', ago(8));
  autoLog.run(eventId, byName('Harish Mehta').id, 'Automation', 'auto', 'No reply after 3 WhatsApp reminders — call follow-up created for Ravi', ago(6));

  // A sample AI status report so the demo shows the feature before an API key is configured.
  require('../src/smart');
  db.prepare("INSERT INTO ai_notes (event_id, kind, content, created_by) VALUES (?, 'summary', ?, 'Demo sample — not generated by AI')").run(eventId, JSON.stringify({
    headline: '30 guests confirmed; 10 parties still silent, 2 VIPs pending',
    summary: 'Aarav & Diya’s guest list stands at 24 parties with 58% responding so far. 30 people are confirmed for the Sangeet, Wedding and Reception, and 18 for the Haldi. The main gaps are 10 parties who haven’t replied (including 2 VIP family members) and hotel IDs for 19 attending guests.',
    risks: [
      { title: 'VIP family not confirmed', detail: 'Harish Mehta (Chacha ji) and Suresh Rao have been called but have not confirmed — elders prefer a personal call from the family.' },
      { title: 'Hotel check-in IDs', detail: '19 attending adults have no ID on file; The Leela needs them 7 days before check-in.' },
      { title: 'Pickups without vehicles', detail: '7 arriving parties on 10–12 Dec need airport/station pickups and have no vehicle assigned yet.' },
    ],
    next_actions: ['Ask the bride’s father to personally call Harish Mehta and Suresh Rao', 'Send the Hinglish ID-request message to the 10 attending parties missing IDs',
      'Block 3 Innovas for the 10 Dec morning arrivals (6E 2100 lands 09:40)', 'Assign hotel rooms to the 3 parties still unassigned'],
    guest_experience_ideas: ['Wheelchair and ground-floor room for Kamla ji (senior) at The Leela', 'Jain-marked counter at the Sangeet — 6 Jain guests confirmed',
      'Kids’ activity corner during the Wedding: 4 children attending'],
  }));
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
