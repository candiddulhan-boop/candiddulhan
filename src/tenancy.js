// Who can see what. Each event company only sees its own weddings; Candid Dulhan (the platform org)
// additionally works on partner weddings whose RSVP-desk service is active.
const db = require('./db');

const SERVICE_LABEL = { none: 'Not requested', requested: 'Requested', active: 'Active', declined: 'Declined' };

const canAccessEvent = (user, e) =>
  !!(user && e) && (e.org_id === user.org_id || (user.platform && e.service_status === 'active'));

// Only the company that owns a wedding may change its settings, rotate the client link or delete it.
const ownsEvent = (user, e) => !!(user && e) && e.org_id === user.org_id;

// SQL filter for the events a user can see.
const eventScope = (user, alias = 'e') => (user.platform
  ? { sql: `(${alias}.org_id = ? OR ${alias}.service_status = 'active')`, args: [user.org_id] }
  : { sql: `${alias}.org_id = ?`, args: [user.org_id] });

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
// plus Candid Dulhan's team when the service is active.
function eventTeam(e) {
  if (!e) return [];
  return db.prepare(`SELECT id, name, role, org_id FROM users WHERE active = 1
    AND (org_id = ? OR (? = 'active' AND org_id = ?)) ORDER BY org_id = ? DESC, name`)
    .all(e.org_id, e.service_status, db.platformOrgId, e.org_id);
}

const orgTeam = (orgId) => db.prepare('SELECT id, name, role, org_id FROM users WHERE active = 1 AND org_id = ? ORDER BY name').all(orgId);

module.exports = { SERVICE_LABEL, canAccessEvent, ownsEvent, eventScope, getEvent, loadEvent, loadGuest, eventTeam, orgTeam };
