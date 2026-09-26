// Who can see what. Each event company only sees its own weddings; Candid Dulhan (the platform org)
// additionally works on partner weddings whose RSVP-desk service is active.
const db = require('./db');

const SERVICE_LABEL = { none: 'Not requested', requested: 'Requested', active: 'Active', declined: 'Declined' };

const isStaff = (userId, eventId) => !!userId && !!db.prepare('SELECT 1 FROM event_staff WHERE event_id = ? AND user_id = ?').get(eventId, userId);

// Partner weddings: Candid Dulhan admins see every active service; other Candid Dulhan staff only the
// weddings they are assigned to.
const canAccessEvent = (user, e) =>
  !!(user && e) && (e.org_id === user.org_id
    || (user.platform && e.service_status === 'active' && (user.role === 'admin' || isStaff(user.uid, e.id))));

// Only the company that owns a wedding may change its settings, rotate the client link or delete it.
const ownsEvent = (user, e) => !!(user && e) && e.org_id === user.org_id;

// SQL filter for the events a user can see.
const eventScope = (user, alias = 'e') => {
  if (!user.platform) return { sql: `${alias}.org_id = ?`, args: [user.org_id] };
  if (user.role === 'admin') return { sql: `(${alias}.org_id = ? OR ${alias}.service_status = 'active')`, args: [user.org_id] };
  return { sql: `(${alias}.org_id = ? OR (${alias}.service_status = 'active'
    AND ${alias}.id IN (SELECT event_id FROM event_staff WHERE user_id = ?)))`, args: [user.org_id, user.uid ?? -1] };
};

const getEvent = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id);

// Load an event the user may access; otherwise answer 404 (not 403, so ids of other companies stay hidden).
function loadEvent(req, res, id) {
  const e = getEvent(id);
  if (canAccessEvent(req.user, e)) return e;
  res.status(404).send('Not found');
  return null;
}

function loadGuest(req, res, id) {
  const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
  const e = g && getEvent(g.event_id);
  if (canAccessEvent(req.user, e)) return { g, e };
  res.status(404).send('Not found');
  return {};
}

// Team members who can be assigned guests on a wedding: the owning company's team,
// plus the Candid Dulhan staff dedicated to it while the service is active.
function eventTeam(e) {
  if (!e) return [];
  return db.prepare(`SELECT id, name, role, org_id FROM users WHERE active = 1
    AND (org_id = ? OR (? = 'active' AND id IN (SELECT user_id FROM event_staff WHERE event_id = ?))) ORDER BY org_id = ? DESC, name`)
    .all(e.org_id, e.service_status, e.id, e.org_id);
}

const eventStaff = (eventId) => db.prepare(`SELECT u.id, u.name, u.login FROM event_staff s JOIN users u ON u.id = s.user_id
  WHERE s.event_id = ? AND u.active = 1 ORDER BY u.name`).all(eventId);

function setEventStaff(eventId, userIds) {
  db.prepare('DELETE FROM event_staff WHERE event_id = ?').run(eventId);
  const add = db.prepare('INSERT OR IGNORE INTO event_staff (event_id, user_id) SELECT ?, id FROM users WHERE id = ? AND org_id = ?');
  for (const id of userIds) add.run(eventId, Number(id), db.platformOrgId);
}

const orgTeam = (orgId) => db.prepare('SELECT id, name, role, org_id FROM users WHERE active = 1 AND org_id = ? ORDER BY name').all(orgId);

module.exports = { eventStaff, setEventStaff, SERVICE_LABEL, canAccessEvent, ownsEvent, eventScope, getEvent, loadEvent, loadGuest, eventTeam, orgTeam };
