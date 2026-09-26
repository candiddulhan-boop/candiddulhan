// "Smart" layer: rule-based alerts that always work, plus Claude-powered summary, Q&A, message drafts and call-note parsing.
const db = require('./db');
const AI = require('./ai');
const W = require('./wedding');
const S = require('./shared');
const { fmtDate } = require('./util');

db.exec(`CREATE TABLE IF NOT EXISTS ai_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- summary
  content TEXT NOT NULL,           -- JSON
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const today = () => new Date(Date.now() + 330 * 60e3).toISOString().slice(0, 10); // IST date
const daysUntil = (d) => (d ? Math.round((Date.parse(d) - Date.parse(today())) / 86400e3) : null);

// ---------------- Rule-based alerts ----------------
function alerts(e) {
  const out = [];
  const add = (level, title, detail, link) => out.push({ level, title, detail, link });
  const q = (sql, ...a) => db.prepare(sql).get(e.id, ...a);
  const base = `/admin/events/${e.id}`;
  const days = daysUntil(e.event_date);
  const firstFn = db.prepare("SELECT MIN(date) d FROM functions WHERE event_id = ? AND date IS NOT NULL AND date != ''").get(e.id).d;
  const daysToFirst = daysUntil(firstFn || e.event_date);

  const pending = q("SELECT COUNT(*) n FROM guests WHERE event_id = ? AND rsvp_status = 'pending'").n;
  if (pending) add(daysToFirst != null && daysToFirst <= 14 ? 'high' : 'medium', `${pending} guests haven’t replied`,
    daysToFirst != null ? `${daysToFirst} days to the first function. Call or remind them.` : 'Call or remind them.', `${base}?status=pending`);
  const vip = q("SELECT COUNT(*) n FROM guests WHERE event_id = ? AND category = 'VIP' AND rsvp_status IN ('pending','maybe')").n;
  if (vip) add('high', `${vip} VIP guest${vip === 1 ? '' : 's'} not confirmed`, 'Personal call recommended.', `${base}?status=open`);
  const maybe = q("SELECT COUNT(*) n FROM guests WHERE event_id = ? AND rsvp_status = 'maybe'").n;
  if (maybe) add('medium', `${maybe} guests said “maybe”`, 'Follow up for a final answer before rooms are locked.', `${base}?status=maybe`);
  const notInvited = q("SELECT COUNT(*) n FROM guests WHERE event_id = ? AND invited_at IS NULL AND phone IS NOT NULL").n;
  if (notInvited) add('medium', `${notInvited} invites not sent yet`, 'Send the WhatsApp invite from the guest list.', base);

  if (e.require_id) {
    const noId = q("SELECT COUNT(*) n FROM guests WHERE event_id = ? AND rsvp_status = 'yes' AND id_file IS NULL").n;
    const memNoId = q(`SELECT COUNT(*) n FROM guest_members m JOIN guests g ON g.id = m.guest_id
      WHERE g.event_id = ? AND g.rsvp_status = 'yes' AND COALESCE(m.age_group, 'Adult') != 'Child' AND m.id_file IS NULL`).n;
    if (noId + memNoId) add(daysToFirst != null && daysToFirst <= 7 ? 'high' : 'medium', `${noId + memNoId} IDs missing for attending guests`,
      `${noId} main guests and ${memNoId} adult family members. Hotels need these at check-in.`, `${base}?status=yes`);
  }

  const extra = String(e.extra_docs || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (e.require_id && extra.length) {
    const attending = q("SELECT COUNT(*) n FROM guests WHERE event_id = ? AND rsvp_status = 'yes'").n;
    for (const t of extra) {
      const have = q(`SELECT COUNT(DISTINCT d.guest_id) n FROM id_documents d JOIN guests g ON g.id = d.guest_id
        WHERE g.event_id = ? AND g.rsvp_status = 'yes' AND d.member_id IS NULL AND d.doc_type = ?`, t).n;
      if (attending - have > 0) add('medium', `${attending - have} attending guests haven’t shared ${t}`, `${t} is requested for this wedding.`, `${base}?status=yes`);
    }
  }
  const soon = q(`SELECT COUNT(*) n FROM guests WHERE event_id = ? AND rsvp_status = 'yes' AND pickup_required = 1
    AND (pickup_vehicle IS NULL OR pickup_vehicle = '') AND arrival_date <= date(?, '+3 days')`, today()).n;
  const later = q(`SELECT COUNT(*) n FROM guests WHERE event_id = ? AND rsvp_status = 'yes' AND pickup_required = 1
    AND (pickup_vehicle IS NULL OR pickup_vehicle = '')`).n;
  if (soon) add('high', `${soon} pickups in the next 3 days have no vehicle`, 'Assign vehicles and drivers now.', `${base}/transport`);
  else if (later) add('low', `${later} pickups still need a vehicle`, 'Plan vehicles by arrival time.', `${base}/transport`);

  const noHotel = q("SELECT COUNT(*) n FROM guests WHERE event_id = ? AND rsvp_status = 'yes' AND needs_stay = 1 AND hotel_id IS NULL").n;
  if (noHotel) add('medium', `${noHotel} attending parties need a hotel room`, 'Assign rooms on the Rooming tab.', `${base}/rooming`);
  for (const h of db.prepare(`SELECT h.name, h.rooms_blocked, COUNT(g.id) used FROM hotels h JOIN guests g ON g.hotel_id = h.id
      AND g.rsvp_status IN ('yes','maybe') WHERE h.event_id = ? AND h.rooms_blocked IS NOT NULL GROUP BY h.id HAVING used > h.rooms_blocked`).all(e.id)) {
    add('high', `${h.name} is over its room block`, `${h.used} parties assigned, ${h.rooms_blocked} rooms blocked.`, `${base}/rooming`);
  }
  const noTravel = q(`SELECT COUNT(*) n FROM guests WHERE event_id = ? AND rsvp_status = 'yes' AND needs_stay = 1
    AND (arrival_date IS NULL OR arrival_date = '')`).n;
  if (noTravel && e.collect_travel) add('medium', `${noTravel} outstation guests haven’t shared arrival details`, 'Ask for flight/train details to plan pickups.', `${base}/transport`);

  const overdue = q("SELECT COUNT(*) n FROM guests WHERE event_id = ? AND follow_up_at IS NOT NULL AND follow_up_at <= datetime('now') AND rsvp_status != 'no'").n;
  if (overdue) add('medium', `${overdue} follow-ups are overdue`, 'Callers should clear these today.', `${base}?due=1`);
  const unassigned = q("SELECT COUNT(*) n FROM guests WHERE event_id = ? AND assigned_to IS NULL AND rsvp_status IN ('pending','maybe')").n;
  if (unassigned && pending) add('low', `${unassigned} open guests have no owner`, 'Use Auto-split to share them among callers.', base);

  const care = q(`SELECT SUM(special_needs IS NOT NULL AND special_needs != '') sn, SUM(allergies IS NOT NULL AND allergies != '') al,
    SUM(COALESCE(kids, 0)) kids FROM guests WHERE event_id = ? AND rsvp_status = 'yes'`);
  if (care.sn || care.al) add('low', 'Special care to plan', `${care.sn || 0} parties with special needs, ${care.al || 0} with allergies, ${care.kids || 0} children attending.`, `${base}?status=yes`);

  if (days != null && days < 0) out.length = 0; // wedding is over — nothing to chase
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// ---------------- Wedding data as context for Claude ----------------
// Phone numbers and ID numbers are deliberately left out.
function weddingContext(e) {
  const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(e.org_id);
  const st = S.stats(e.id);
  const fns = W.functionStats(e.id);
  const answers = W.guestFunctionMap(e.id);
  const hotels = db.prepare(`SELECT h.*, (SELECT COUNT(*) FROM guests g WHERE g.hotel_id = h.id AND g.rsvp_status IN ('yes','maybe')) used
    FROM hotels h WHERE h.event_id = ?`).all(e.id);
  const hotelName = new Map(hotels.map((h) => [h.id, h.name]));
  const members = new Map(db.prepare(`SELECT m.guest_id, COUNT(*) n, SUM(m.id_file IS NOT NULL) ids,
      GROUP_CONCAT(m.name || COALESCE(' (' || m.relation || ')', ''), '; ') names
    FROM guest_members m JOIN guests g ON g.id = m.guest_id WHERE g.event_id = ? GROUP BY m.guest_id`).all(e.id).map((r) => [r.guest_id, r]));
  const guests = db.prepare(`SELECT g.*, u.name owner, (SELECT COUNT(*) FROM calls c WHERE c.guest_id = g.id) calls,
      (SELECT outcome FROM calls c WHERE c.guest_id = g.id ORDER BY called_at DESC LIMIT 1) last_call
    FROM guests g LEFT JOIN users u ON u.id = g.assigned_to WHERE g.event_id = ? ORDER BY g.name`).all(e.id);
  const val = (v) => (v == null || v === '' ? '' : String(v).replace(/[|\n\r]/g, ' '));
  const cols = ['guest', 'relation', 'side', 'group', 'category', 'city', 'language', 'invited_for', 'kids', 'overall_rsvp', 'attending_pax',
    'functions', 'arrival', 'pickup', 'departure', 'drop', 'stay', 'hotel_room', 'food', 'allergies', 'special_needs', 'family_members',
    'id_status', 'invite_sent', 'responded', 'calls', 'last_call', 'follow_up', 'owner', 'guest_message', 'team_notes'];
  const rows = guests.map((g) => {
    const m = members.get(g.id);
    const fa = answers.get(g.id);
    return [
      [g.salutation, g.name].filter(Boolean).join(' '), g.relation, g.side, g.group_name, g.category, g.city, g.language, g.max_pax, g.kids,
      g.rsvp_status, g.pax,
      fns.filter((f) => fa?.has(f.id)).map((f) => `${f.name}:${fa.get(f.id).rsvp}${fa.get(f.id).rsvp === 'yes' ? `(${fa.get(f.id).pax ?? 1})` : ''}`).join(' '),
      [g.arrival_date, g.arrival_time, g.arrival_mode, g.arrival_details, g.arrival_point].filter(Boolean).join(' '),
      g.pickup_required == null ? '' : g.pickup_required ? `needed ${g.pickup_status || 'Pending'}${g.pickup_vehicle ? ` vehicle:${g.pickup_vehicle}` : ' no-vehicle'}` : 'not needed',
      [g.departure_date, g.departure_time, g.departure_mode, g.departure_number].filter(Boolean).join(' '),
      g.drop_required == null ? '' : g.drop_required ? `needed ${g.drop_status || 'Pending'}` : 'not needed',
      g.needs_stay == null ? '' : g.needs_stay ? 'needs stay' : 'no stay',
      [hotelName.get(g.hotel_id), g.room_type, g.room_no].filter(Boolean).join(' '),
      g.dietary, g.allergies, g.special_needs, m ? `${m.n}: ${m.names}` : '',
      `${g.id_file ? 'main ID received' : g.id_type ? 'main ID number only' : 'main ID missing'}${m ? `, members ${m.ids || 0}/${m.n} IDs` : ''}`,
      g.invited_at ? fmtDate(g.invited_at) : 'not sent', g.responded_at ? fmtDate(g.responded_at) : '', g.calls, g.last_call,
      g.follow_up_at ? fmtDate(g.follow_up_at) : '', g.owner, g.guest_notes, g.internal_notes,
    ].map(val).join(' | ');
  });
  return [
    `WEDDING: ${e.title} | date ${e.event_date || 'n/a'} | venue ${e.venue || 'n/a'}, ${e.city || ''} | planner: ${org?.name || ''} | today: ${today()}`,
    `TOTALS: ${st.total} guest parties, ${st.yes} attending (${st.pax} people), ${st.no} declined, ${st.maybe} maybe, ${st.pending} awaiting; ${st.ids} IDs; ${st.stay} need stay; ${st.calls} calls logged`,
    `FUNCTIONS:\n${fns.map((f) => `- ${f.name}: ${[f.date, f.time, f.venue].filter(Boolean).join(' ')} | invited ${f.invited}, attending ${f.yes || 0} parties (${f.people} people), maybe ${f.maybe || 0}, declined ${f.no || 0}, awaiting ${f.pending || 0}`).join('\n') || '(none)'}`,
    `HOTELS:\n${hotels.map((h) => `- ${h.name}: ${h.used} parties assigned${h.rooms_blocked ? ` of ${h.rooms_blocked} rooms blocked` : ''}`).join('\n') || '(none)'}`,
    `GUESTS (one party per line; columns separated by |):\n${cols.join(' | ')}\n${rows.join('\n')}`,
  ].join('\n\n');
}

const BASE_INSTRUCTIONS = `You are the guest-management assistant inside an Indian wedding planning platform used by professional wedding planners.
You understand Indian weddings: multiple functions (Haldi, Mehndi, Sangeet, Wedding/Pheras, Reception), large families travelling together,
elders who prefer calls to WhatsApp, Jain/vegetarian food needs, and hotel check-in requiring government ID for every adult.
Be precise with numbers — count from the data, never guess. If the data doesn't contain the answer, say so plainly.
Write for a busy planner: short, clear, practical. Use Indian English. Plain text with simple "-" bullets; no markdown tables or headings.`;

// ---------------- AI: executive summary ----------------
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'summary', 'risks', 'next_actions', 'guest_experience_ideas'],
  properties: {
    headline: { type: 'string', description: 'One line status headline, max 12 words.' },
    summary: { type: 'string', description: '3-4 sentence executive summary with the key numbers, suitable for the couple and family.' },
    risks: {
      type: 'array', description: 'Top risks, most urgent first (max 5).',
      items: { type: 'object', additionalProperties: false, required: ['title', 'detail'], properties: { title: { type: 'string' }, detail: { type: 'string' } } },
    },
    next_actions: {
      type: 'array', description: 'Concrete next actions for the planner team for the next 48 hours (max 6), naming guests where useful.',
      items: { type: 'string' },
    },
    guest_experience_ideas: {
      type: 'array', description: 'Thoughtful, specific ideas to delight guests based on the data (seniors, kids, dietary needs, arrivals…) (max 4).',
      items: { type: 'string' },
    },
  },
};

async function generateSummary(e, who) {
  const result = await AI.run({
    instructions: BASE_INSTRUCTIONS,
    data: weddingContext(e),
    prompt: 'Prepare today’s guest-management status report for this wedding.',
    schema: SUMMARY_SCHEMA,
    effort: 'medium',
  });
  db.prepare("INSERT INTO ai_notes (event_id, kind, content, created_by) VALUES (?, 'summary', ?, ?)").run(e.id, JSON.stringify(result), who || null);
  return result;
}

function latestSummary(eventId) {
  const r = db.prepare("SELECT * FROM ai_notes WHERE event_id = ? AND kind = 'summary' ORDER BY id DESC LIMIT 1").get(eventId);
  if (!r) return null;
  try { return { ...JSON.parse(r.content), created_at: r.created_at, created_by: r.created_by }; } catch { return null; }
}

// ---------------- AI: ask anything ----------------
const SUGGESTED_QUESTIONS = [
  'Which VIP or family guests still haven’t confirmed, and who owns them?',
  'How many people arrive on each day, and how many need airport or station pickups?',
  'List Jain and vegetarian headcount for the Sangeet.',
  'Which attending guests are missing IDs for check-in?',
  'Who are the senior citizens or guests with special needs we should take care of?',
  'Summarise the Groom side vs Bride side attendance per function.',
];

async function ask(e, question) {
  const q = String(question || '').trim().slice(0, 1000);
  if (!q) throw new AI.AiError('Type a question first.');
  return AI.run({ instructions: BASE_INSTRUCTIONS, data: weddingContext(e), prompt: q, effort: 'medium' });
}

// ---------------- AI: personalised WhatsApp message ----------------
const PURPOSES = {
  reminder: 'a gentle reminder to RSVP',
  invite: 'a warm personal invitation',
  id_request: 'a polite request to upload government IDs for hotel check-in',
  travel: 'a request to share arrival/departure travel details for pickups',
  itinerary: 'a personalised itinerary: their functions with dates/times/venues/dress code, their hotel and room, and pickup details',
  thanks: 'a heartfelt thank-you after the wedding',
};
const LANGUAGES = ['English', 'Hindi', 'Hinglish'];

async function draftMessage(e, g, { purpose = 'reminder', language = 'English', link } = {}) {
  const fns = W.functionsOf(e.id);
  const answers = W.guestFunctions(g.id);
  const hotel = g.hotel_id ? db.prepare('SELECT name FROM hotels WHERE id = ?').get(g.hotel_id)?.name : null;
  const profile = [
    `Guest: ${[g.salutation, g.name].filter(Boolean).join(' ')}; relation: ${g.relation || 'n/a'}; side: ${g.side || 'n/a'}; invited for ${g.max_pax}`,
    `RSVP: ${g.rsvp_status}; functions: ${fns.filter((f) => answers.has(f.id)).map((f) => `${f.name} (${[f.date, f.time, f.venue, f.dress_code && `dress: ${f.dress_code}`].filter(Boolean).join(', ')}) → ${answers.get(f.id).rsvp}`).join('; ') || 'n/a'}`,
    `Arrival: ${[g.arrival_date, g.arrival_time, g.arrival_mode, g.arrival_details].filter(Boolean).join(' ') || 'not shared'}; pickup: ${g.pickup_vehicle || g.pickup_status || 'n/a'}`,
    `Stay: ${hotel ? `${hotel}${g.room_no ? ` room ${g.room_no}` : ''}` : g.needs_stay ? 'needs stay, hotel not assigned yet' : 'n/a'}`,
    `ID: ${g.id_file ? 'received' : 'missing'}`,
  ].join('\n');
  return AI.run({
    instructions: `${BASE_INSTRUCTIONS}
You write WhatsApp messages on behalf of the wedding hosts. Warm, respectful and personal (use ji / namaste where natural), 60-120 words,
at most 2 emojis, no hashtags. Never invent facts that are not in the data. If a personal RSVP link is given, include it exactly once.
Output only the message text.`,
    prompt: `Wedding: ${e.title}, ${e.event_date || ''} at ${[e.venue, e.city].filter(Boolean).join(', ')}.
${profile}
${link ? `Personal RSVP link: ${link}` : ''}
Write ${PURPOSES[purpose] || PURPOSES.reminder} in ${LANGUAGES.includes(language) ? language : 'English'}${language === 'Hindi' ? ' (Devanagari script)' : ''}.`,
    effort: 'low',
    maxTokens: 2000,
  });
}

// ---------------- AI: smart fill from rough call notes ----------------
const MODES = ['Flight', 'Train', 'Car', 'Bus', 'Local'];
const DIETS = ['Vegetarian', 'Non-vegetarian', 'Jain', 'Vegan', 'Eggetarian', 'Other'];

// Keep only values that fit our fields, whatever the model returned.
function cleanExtract(x, fnIds) {
  const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const time = (v) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null);
  const oneOf = (v, list) => (list.includes(v) ? v : null);
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
  const bool = (v) => (typeof v === 'boolean' ? v : null);
  return {
    functions: (Array.isArray(x.functions) ? x.functions : []).filter((f) => fnIds.includes(f.function_id) && ['yes', 'no', 'maybe'].includes(f.rsvp))
      .map((f) => ({ function_id: f.function_id, rsvp: f.rsvp, pax: Number.isInteger(f.pax) && f.pax >= 0 ? f.pax : null })),
    arrival_date: date(x.arrival_date), arrival_time: time(x.arrival_time), arrival_mode: oneOf(x.arrival_mode, MODES),
    arrival_details: str(x.arrival_details), arrival_point: str(x.arrival_point), pickup_required: bool(x.pickup_required),
    departure_date: date(x.departure_date), departure_time: time(x.departure_time), departure_mode: oneOf(x.departure_mode, MODES),
    departure_number: str(x.departure_number), drop_required: bool(x.drop_required), needs_stay: bool(x.needs_stay),
    dietary: oneOf(x.dietary, DIETS), allergies: str(x.allergies), special_needs: str(x.special_needs),
    kids: Number.isInteger(x.kids) && x.kids >= 0 ? x.kids : null, clean_note: str(x.clean_note) || '', suggested_follow_up: str(x.suggested_follow_up),
  };
}
function extractSchema(fns) {
  const s = (d) => ({ type: ['string', 'null'], description: d });
  const yn = (d) => ({ type: ['boolean', 'null'], description: d });
  return {
    type: 'object',
    additionalProperties: false,
    required: ['functions', 'arrival_date', 'arrival_time', 'arrival_mode', 'arrival_details', 'arrival_point', 'pickup_required',
      'departure_date', 'departure_time', 'departure_mode', 'departure_number', 'drop_required', 'needs_stay', 'dietary', 'allergies',
      'special_needs', 'kids', 'clean_note', 'suggested_follow_up'],
    properties: {
      functions: {
        type: 'array', description: 'Only functions the notes say something about.',
        items: {
          type: 'object', additionalProperties: false, required: ['function_id', 'rsvp', 'pax'],
          properties: {
            function_id: { type: 'integer', description: `One of the function ids: ${fns.map((f) => `${f.id} (${f.name})`).join(', ')}` },
            rsvp: { type: 'string', enum: ['yes', 'no', 'maybe'] },
            pax: { type: ['integer', 'null'], description: 'People attending this function, if stated' },
          },
        },
      },
      arrival_date: s('YYYY-MM-DD'), arrival_time: s('HH:MM 24h'), arrival_mode: s(`One of: ${MODES.join(', ')}`),
      arrival_details: s('Flight/train number'), arrival_point: s('Airport/station'), pickup_required: yn('Pickup needed'),
      departure_date: s('YYYY-MM-DD'), departure_time: s('HH:MM 24h'), departure_mode: s(`One of: ${MODES.join(', ')}`),
      departure_number: s('Flight/train number'), drop_required: yn('Drop needed'), needs_stay: yn('Needs accommodation'),
      dietary: s(`One of: ${DIETS.join(', ')}`),
      allergies: s('Allergies'), special_needs: s('Wheelchair, elderly, infant…'), kids: { type: ['integer', 'null'] },
      clean_note: { type: 'string', description: 'The call notes rewritten as one clear English sentence or two for the timeline.' },
      suggested_follow_up: s('If a callback is needed: when and why, e.g. "Tomorrow evening — confirming Sangeet"'),
    },
  };
}

async function extractFromNotes(e, g, notes) {
  const n = String(notes || '').trim().slice(0, 3000);
  if (!n) throw new AI.AiError('Write your call notes first.');
  const fns = W.functionsOf(e.id).filter((f) => W.guestFunctions(g.id).has(f.id));
  const raw = await AI.run({
    instructions: `${BASE_INSTRUCTIONS}
You turn a caller's rough notes (English, Hindi or Hinglish) into structured guest data. Only fill a field when the notes clearly state it;
otherwise use null. Resolve relative dates ("10 tareek", "day before the wedding") using the wedding and function dates.`,
    prompt: `Wedding: ${e.title}; wedding date ${e.event_date || 'n/a'}.
Functions this guest is invited to: ${fns.map((f) => `id ${f.id} = ${f.name} on ${f.date || 'n/a'}`).join('; ') || 'none'}.
Guest: ${g.name}, invited for ${g.max_pax} people.
Call notes: """${n}"""`,
    schema: extractSchema(fns),
    effort: 'low',
    maxTokens: 4000,
  });
  return cleanExtract(raw, fns.map((f) => f.id));
}

module.exports = { alerts, weddingContext, generateSummary, latestSummary, ask, SUGGESTED_QUESTIONS, draftMessage, PURPOSES, LANGUAGES, extractFromNotes, daysUntil };
