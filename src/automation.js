// Automation engine: per-wedding rules that run on a schedule — WhatsApp reminders and requests, itineraries,
// escalation to callers, auto-assignment, a daily planner digest, thank-you messages and ID auto-deletion.
const db = require('./db');
const WA = require('./whatsapp');
const S = require('./shared');
const T = require('./tenancy');
const V = require('./vault');

db.exec(`CREATE TABLE IF NOT EXISTS automations (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  rule TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT,
  last_run_at TEXT,
  PRIMARY KEY (event_id, rule)
)`);

// Rule catalogue. `n` / `max` / `days` are editable per wedding.
const RULES = {
  rsvp_reminders: {
    label: 'RSVP reminders', icon: '🔔', whatsapp: true, defaults: { every: 3, max: 3 },
    describe: (c) => `Every ${c.every} days, send the RSVP reminder (with reply buttons) to guests who haven’t replied — up to ${c.max} times.`,
  },
  escalate_to_callers: {
    label: 'Hand silent guests to callers', icon: '📞', defaults: { after: 3 },
    describe: (c) => `If a guest hasn’t replied after ${c.after} reminders, create a call follow-up for today and assign a caller.`,
  },
  auto_assign: {
    label: 'Auto-assign new guests', icon: '👥', defaults: {},
    describe: () => 'Share unassigned guests who haven’t confirmed equally among the wedding’s callers.',
  },
  id_requests: {
    label: 'ID requests', icon: '🪪', whatsapp: true, defaults: { every: 4, max: 3 },
    describe: (c) => `Every ${c.every} days, ask attending guests who haven’t uploaded an ID — up to ${c.max} times.`,
  },
  travel_requests: {
    label: 'Travel details requests', icon: '✈️', whatsapp: true, defaults: { every: 4, max: 2 },
    describe: (c) => `Every ${c.every} days, ask attending guests without arrival details — up to ${c.max} times.`,
  },
  itinerary: {
    label: 'Personal itineraries', icon: '🗓', whatsapp: true, defaults: { days: 2 },
    describe: (c) => `${c.days} days before the first function, send each attending guest their functions, hotel room and pickup.`,
  },
  daily_digest: {
    label: 'Daily summary to planner', icon: '📊', whatsapp: true, defaults: { hour: 9 },
    describe: (c) => `Every morning at ${c.hour}:00, WhatsApp the planner a summary: confirmed, awaiting, IDs pending, pickups without cars.`,
  },
  thank_you: {
    label: 'Thank-you messages', icon: '🙏', whatsapp: true, defaults: { days: 1 },
    describe: (c) => `${c.days} day${c.days == 1 ? '' : 's'} after the wedding, thank every guest who attended.`,
  },
  id_retention: {
    label: 'Auto-delete IDs after the wedding', icon: '🔐', defaults: {},
    describe: (_c, e) => (e?.id_retention_days ? `Delete all ID documents ${e.id_retention_days} days after the wedding.` : 'Set “Auto-delete IDs after N days” in wedding Settings to switch this on.'),
  },
};

const istNow = () => new Date(Date.now() + 330 * 60e3);
const istToday = () => istNow().toISOString().slice(0, 10);
const istHour = () => istNow().getUTCHours();
const QUIET = { from: 9, to: 20 }; // guest messages only 9 am – 8 pm IST

function settings(eventId) {
  const rows = new Map(db.prepare('SELECT * FROM automations WHERE event_id = ?').all(eventId).map((r) => [r.rule, r]));
  return Object.fromEntries(Object.entries(RULES).map(([k, rule]) => {
    const r = rows.get(k);
    let c = {};
    try { c = JSON.parse(r?.config || '{}'); } catch {}
    return [k, { enabled: !!r?.enabled, config: { ...rule.defaults, ...c }, last_run_at: r?.last_run_at || null }];
  }));
}

function save(eventId, rule, { enabled, config }) {
  const clean = Object.fromEntries(Object.entries(RULES[rule].defaults).map(([k, d]) => {
    const v = Number(config?.[k]);
    return [k, Number.isFinite(v) && v >= 0 && v <= 60 ? v : d];
  }));
  db.prepare(`INSERT INTO automations (event_id, rule, enabled, config) VALUES (?,?,?,?)
    ON CONFLICT (event_id, rule) DO UPDATE SET enabled = excluded.enabled, config = excluded.config`).run(eventId, rule, enabled ? 1 : 0, JSON.stringify(clean));
}

const sentCount = (guestId, purpose) => db.prepare("SELECT COUNT(*) n, MAX(created_at) last FROM wa_messages WHERE guest_id = ? AND direction = 'out' AND purpose = ? AND status != 'failed'").get(guestId, purpose);
const daysSince = (sqlDate) => (sqlDate ? (Date.now() - Date.parse(`${sqlDate.replace(' ', 'T')}Z`)) / 86400e3 : Infinity);
const log = (e, detail) => S.logActivity(e.id, null, 'Automation', 'auto', detail);

// Guests due for a repeated request: under `max` sends and at least `every` days since the last one.
function dueFor(guests, purpose, { every, max }) {
  const gap = Math.max(1, every); // never the same message twice within a day
  return guests.filter((g) => {
    const s = sentCount(g.id, purpose);
    return s.n < max && daysSince(s.last) >= gap;
  });
}

async function sendBatch(e, purpose, guests) {
  if (!guests.length) return 0;
  const r = await WA.runCampaign(e.id, purpose, guests, { who: 'Automation', source: 'auto', audience: 'auto' });
  return r.sent;
}

// Run every enabled rule for one wedding. `force` ignores quiet hours (used by "Run now").
async function runEvent(eventId, { force = false } = {}) {
  const e = WA.eventWithOrg(eventId);
  if (!e) return [];
  const st = settings(e.id);
  const out = [];
  const quiet = !force && (istHour() < QUIET.from || istHour() >= QUIET.to);
  const waOk = WA.canSend(e);
  const today = istToday();
  const g = (sql, ...a) => db.prepare(`SELECT * FROM guests WHERE event_id = ? AND phone IS NOT NULL AND phone != '' AND ${sql}`).all(e.id, ...a);
  const firstFn = db.prepare("SELECT MIN(date) d FROM functions WHERE event_id = ? AND date IS NOT NULL AND date != ''").get(e.id).d || e.event_date;
  const lastDay = db.prepare("SELECT MAX(date) d FROM functions WHERE event_id = ? AND date IS NOT NULL AND date != ''").get(e.id).d || e.event_date;
  const before = firstFn ? Math.round((Date.parse(firstFn) - Date.parse(today)) / 86400e3) : null;
  const after = lastDay ? Math.round((Date.parse(today) - Date.parse(lastDay)) / 86400e3) : null;
  const on = (k) => st[k].enabled && !(RULES[k].whatsapp && (!waOk || quiet));
  const mark = (k) => db.prepare("UPDATE automations SET last_run_at = datetime('now') WHERE event_id = ? AND rule = ?").run(e.id, k);

  if (on('rsvp_reminders') && (before == null || before >= 0)) {
    const c = st.rsvp_reminders.config;
    // Only guests who were invited at least `every` days ago.
    const due = dueFor(g("rsvp_status = 'pending' AND invited_at IS NOT NULL AND invited_at <= datetime('now', ?)", `-${c.every} days`), 'reminder', c);
    const n = await sendBatch(e, 'reminder', due);
    if (n) { out.push(`Sent ${n} RSVP reminders`); log(e, `Sent ${n} RSVP reminders on WhatsApp`); }
    mark('rsvp_reminders');
  }
  if (st.escalate_to_callers.enabled) {
    const c = st.escalate_to_callers.config;
    const silent = db.prepare(`SELECT * FROM guests WHERE event_id = ? AND rsvp_status = 'pending' AND follow_up_at IS NULL`).all(e.id)
      .filter((x) => sentCount(x.id, 'reminder').n >= c.after);
    const callers = T.eventTeam(e).filter((u) => u.role === 'caller');
    const team = callers.length ? callers : T.eventTeam(e);
    const load = new Map(team.map((u) => [u.id, db.prepare("SELECT COUNT(*) n FROM guests WHERE assigned_to = ? AND event_id = ? AND rsvp_status IN ('pending','maybe')").get(u.id, e.id).n]));
    for (const x of silent) {
      let owner = x.assigned_to;
      if (!owner && team.length) {
        owner = [...load.entries()].sort((a, b) => a[1] - b[1])[0][0];
        load.set(owner, load.get(owner) + 1);
        db.prepare('UPDATE guests SET assigned_to = ? WHERE id = ?').run(owner, x.id);
      }
      db.prepare("UPDATE guests SET follow_up_at = datetime('now') WHERE id = ?").run(x.id);
      const name = team.find((u) => u.id === owner)?.name;
      S.logActivity(e.id, x.id, 'Automation', 'auto', `No reply after ${c.after} WhatsApp reminders — call follow-up created${name ? ` for ${name}` : ''}`);
    }
    if (silent.length) out.push(`Escalated ${silent.length} silent guests to callers`);
    mark('escalate_to_callers');
  }
  if (st.auto_assign.enabled) {
    const callers = T.eventTeam(e).filter((u) => u.role === 'caller');
    const todo = db.prepare("SELECT id FROM guests WHERE event_id = ? AND assigned_to IS NULL AND rsvp_status IN ('pending','maybe') ORDER BY side, group_name, name").all(e.id);
    if (callers.length && todo.length) {
      const load = new Map(callers.map((u) => [u.id, db.prepare("SELECT COUNT(*) n FROM guests WHERE assigned_to = ? AND event_id = ? AND rsvp_status IN ('pending','maybe')").get(u.id, e.id).n]));
      for (const x of todo) {
        const [uid] = [...load.entries()].sort((a, b) => a[1] - b[1])[0];
        db.prepare('UPDATE guests SET assigned_to = ? WHERE id = ?').run(uid, x.id);
        load.set(uid, load.get(uid) + 1);
      }
      out.push(`Assigned ${todo.length} guests to callers`);
      log(e, `Auto-assigned ${todo.length} guests among ${callers.map((u) => u.name).join(', ')}`);
    }
    mark('auto_assign');
  }
  if (on('id_requests') && e.require_id && (before == null || before >= 0)) {
    const n = await sendBatch(e, 'id_request', dueFor(g("rsvp_status = 'yes' AND id_file IS NULL"), 'id_request', st.id_requests.config));
    if (n) { out.push(`Sent ${n} ID requests`); log(e, `Sent ${n} ID requests on WhatsApp`); }
    mark('id_requests');
  }
  if (on('travel_requests') && e.collect_travel && (before == null || before >= 0)) {
    const n = await sendBatch(e, 'travel', dueFor(g("rsvp_status = 'yes' AND (arrival_date IS NULL OR arrival_date = '')"), 'travel', st.travel_requests.config));
    if (n) { out.push(`Sent ${n} travel-details requests`); log(e, `Sent ${n} travel-details requests on WhatsApp`); }
    mark('travel_requests');
  }
  if (on('itinerary') && before != null && before >= 0 && before <= st.itinerary.config.days) {
    const n = await sendBatch(e, 'itinerary', g("rsvp_status = 'yes'").filter((x) => sentCount(x.id, 'itinerary').n === 0));
    if (n) { out.push(`Sent ${n} itineraries`); log(e, `Sent ${n} personal itineraries on WhatsApp`); }
    mark('itinerary');
  }
  if (on('daily_digest') && (force || istHour() >= st.daily_digest.config.hour)) {
    const last = st.daily_digest.last_run_at;
    const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(e.org_id);
    const to = e.client_phone && e.org_id === db.platformOrgId ? e.client_phone : org.phone || e.client_phone;
    if (to && (force || !last || last.slice(0, 10) < new Date().toISOString().slice(0, 10))) {
      const s = S.stats(e.id);
      const pickups = db.prepare("SELECT COUNT(*) n FROM guests WHERE event_id = ? AND rsvp_status = 'yes' AND pickup_required = 1 AND (pickup_vehicle IS NULL OR pickup_vehicle = '')").get(e.id).n;
      const params = [e.title, s.yes, s.pax, s.pending, Math.max(0, s.yes - s.ids), pickups].map(String);
      await WA.sendTemplate(e, { id: null, name: org.contact_name || org.name, phone: to, token: '' }, 'digest', { who: 'Automation', params });
      log(e, `Daily summary sent to the planner on WhatsApp`);
      out.push('Sent the daily summary to the planner');
      mark('daily_digest');
    }
  }
  if (on('thank_you') && after != null && after >= st.thank_you.config.days && after <= st.thank_you.config.days + 3) {
    const n = await sendBatch(e, 'thanks', g("rsvp_status = 'yes'").filter((x) => sentCount(x.id, 'thanks').n === 0));
    if (n) { out.push(`Sent ${n} thank-you messages`); log(e, `Sent ${n} thank-you messages on WhatsApp`); }
    mark('thank_you');
  }
  if (st.id_retention.enabled && e.id_retention_days && after != null && after >= e.id_retention_days) {
    const n = V.purgeEvent(e.id);
    if (n) { out.push(`Deleted ${n} ID files (retention)`); log(e, `ID documents auto-deleted ${e.id_retention_days} days after the wedding (${n} files)`); }
    mark('id_retention');
  }
  if (quiet && Object.entries(st).some(([k, v]) => v.enabled && RULES[k].whatsapp)) out.push('WhatsApp rules wait for 9 am – 8 pm');
  if (!waOk && Object.entries(st).some(([k, v]) => v.enabled && RULES[k].whatsapp)) out.push('WhatsApp rules need the Candid Dulhan RSVP desk for this wedding');
  return out;
}

// Scheduler: every few minutes, run all weddings that have any rule switched on and aren't long over.
let timer = null;
function start(minutes = Number(process.env.AUTOMATION_INTERVAL_MIN || 10)) {
  if (timer || !(minutes > 0)) return;
  const tick = async () => {
    const events = db.prepare(`SELECT DISTINCT a.event_id id FROM automations a JOIN events e ON e.id = a.event_id
      WHERE a.enabled = 1 AND (e.event_date IS NULL OR e.event_date >= date('now', '-120 days'))`).all();
    for (const { id } of events) {
      try { await runEvent(id); } catch (err) { console.error(`Automation error for wedding ${id}`, err); }
    }
  };
  timer = setInterval(tick, minutes * 60e3);
  timer.unref();
  setTimeout(tick, 15e3).unref();
}

module.exports = { RULES, settings, save, runEvent, start };
