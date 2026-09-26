// Single definition of every built-in guest field. Drives the guest edit form, CSV export and CSV import,
// so adding a field here makes it appear everywhere.
const db = require('./db');
const { html, fmtDate } = require('./util');

const YESNO = [['', ''], ['1', 'Yes'], ['0', 'No']];
const opts = (...xs) => ['', ...xs].map((x) => [x, x]);
const MODES = opts('Flight', 'Train', 'Car', 'Bus', 'Local');

// [section, key, label, type, options?, extra?]
const GUEST_FIELDS = [
  ['Contact', 'salutation', 'Salutation', 'select', opts('Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Shri', 'Smt.', 'Family')],
  ['Contact', 'name', 'Name', 'text', null, { required: true }],
  ['Contact', 'phone', 'Mobile (WhatsApp)', 'tel'],
  ['Contact', 'alt_phone', 'Alternate phone', 'tel'],
  ['Contact', 'email', 'Email', 'email'],
  ['Contact', 'city', 'City', 'text'],
  ['Contact', 'language', 'Preferred language', 'select', opts('Hindi', 'English', 'Marwari', 'Gujarati', 'Punjabi', 'Marathi', 'Bengali', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Other')],

  ['Relation', 'side', 'Side', 'select', opts('Bride', 'Groom', 'Both')],
  ['Relation', 'relation', 'Relation to couple', 'text', null, { placeholder: 'Mama ji, college friend…' }],
  ['Relation', 'group_name', 'Group', 'text', null, { placeholder: 'Family / Friends / Office' }],
  ['Relation', 'category', 'Category', 'select', opts('VIP', 'Family', 'Friends', 'Office', 'Neighbours', 'Vendor', 'Other')],
  ['Relation', 'tags', 'Tags', 'text', null, { placeholder: 'comma separated' }],
  ['Relation', 'max_pax', 'Invited for (people)', 'number', null, { min: 1 }],
  ['Relation', 'kids', 'Children in party', 'number', null, { min: 0 }],

  ['Arrival', 'arrival_date', 'Arrival date', 'date'],
  ['Arrival', 'arrival_time', 'Arrival time', 'time'],
  ['Arrival', 'arrival_mode', 'Arriving by', 'select', MODES],
  ['Arrival', 'arrival_details', 'Flight / train no.', 'text', null, { placeholder: '6E 2134' }],
  ['Arrival', 'arrival_from', 'Coming from (city)', 'text'],
  ['Arrival', 'arrival_point', 'Arriving at', 'text', null, { placeholder: 'Udaipur airport T1 / Jaipur Jn' }],
  ['Arrival', 'pickup_required', 'Pickup needed', 'select', YESNO],
  ['Arrival', 'pickup_status', 'Pickup status', 'select', opts('Pending', 'Assigned', 'Done')],
  ['Arrival', 'pickup_vehicle', 'Vehicle / driver', 'text', null, { placeholder: 'Innova RJ14 1234 · Ramesh 98…' }],

  ['Departure', 'departure_date', 'Departure date', 'date'],
  ['Departure', 'departure_time', 'Departure time', 'time'],
  ['Departure', 'departure_mode', 'Leaving by', 'select', MODES],
  ['Departure', 'departure_number', 'Flight / train no.', 'text'],
  ['Departure', 'departure_point', 'Leaving from', 'text'],
  ['Departure', 'drop_required', 'Drop needed', 'select', YESNO],
  ['Departure', 'drop_status', 'Drop status', 'select', opts('Pending', 'Assigned', 'Done')],
  ['Departure', 'drop_vehicle', 'Vehicle / driver', 'text'],

  ['Stay', 'needs_stay', 'Needs accommodation', 'select', YESNO],
  ['Stay', 'hotel_id', 'Hotel', 'hotel'],
  ['Stay', 'room_type', 'Room type', 'select', opts('Single', 'Double', 'Twin', 'Triple', 'Suite', 'Villa', 'Dormitory')],
  ['Stay', 'room_no', 'Room no.', 'text'],
  ['Stay', 'check_in', 'Check-in', 'date'],
  ['Stay', 'check_out', 'Check-out', 'date'],
  ['Stay', 'sharing_with', 'Sharing room with', 'text'],

  ['Care', 'dietary', 'Food preference', 'select', opts('Vegetarian', 'Non-vegetarian', 'Jain', 'Vegan', 'Eggetarian', 'Other')],
  ['Care', 'allergies', 'Allergies', 'text'],
  ['Care', 'special_needs', 'Special needs', 'text', null, { placeholder: 'Wheelchair, elderly, infant…' }],
  ['Care', 'hamper_status', 'Welcome hamper', 'select', opts('Pending', 'Packed', 'Delivered')],

  ['Notes', 'guest_notes', 'Guest’s message', 'textarea'],
  ['Notes', 'internal_notes', 'Internal notes (team only)', 'textarea'],
].map(([section, key, label, type, options, extra = {}]) => ({ section, key, label, type, options, ...extra }));

const FIELD = Object.fromEntries(GUEST_FIELDS.map((f) => [f.key, f]));
const SECTIONS = [...new Set(GUEST_FIELDS.map((f) => f.section))];
const INT_FIELDS = new Set(['max_pax', 'kids', 'pickup_required', 'drop_required', 'needs_stay', 'hotel_id']);

const hotelsOf = (eventId) => db.prepare('SELECT id, name FROM hotels WHERE event_id = ? ORDER BY name').all(eventId);

function input(f, value, { hotels = [], name = f.key } = {}) {
  const v = value ?? '';
  if (f.type === 'select' || f.type === 'hotel') {
    const options = f.type === 'hotel' ? [['', hotels.length ? '—' : 'Add hotels first'], ...hotels.map((h) => [h.id, h.name])] : f.options;
    return html`<select name="${name}">${options.map(([k, l]) => html`<option value="${k}" ${String(v) === String(k) ? 'selected' : ''}>${l}</option>`)}</select>`;
  }
  if (f.type === 'textarea') return html`<textarea name="${name}" rows="2">${v}</textarea>`;
  return html`<input type="${f.type}" name="${name}" value="${v}" ${f.required ? 'required' : ''}
    ${f.min != null ? html`min="${f.min}"` : ''} ${f.placeholder ? html`placeholder="${f.placeholder}"` : ''}>`;
}

// Form section(s) for the given keys (or whole sections).
function formSection(section, guest, ctx) {
  const fs = GUEST_FIELDS.filter((f) => f.section === section);
  return html`<fieldset><legend>${section}</legend><div class="fields">
    ${fs.map((f) => html`<label class="${f.type === 'textarea' ? 'wide' : ''}">${f.label}${input(f, guest[f.key], ctx)}</label>`)}
  </div></fieldset>`;
}

// Parse posted values for the given field keys into DB values.
function parse(body, keys) {
  const out = {};
  for (const k of keys) {
    if (!(k in body)) continue;
    const raw = String(body[k] ?? '').trim().slice(0, 500);
    out[k] = raw === '' ? null : INT_FIELDS.has(k) ? Number(raw) : raw;
  }
  if ('max_pax' in out) out.max_pax = Math.max(1, out.max_pax || 1);
  return out;
}

function update(guestId, values) {
  const keys = Object.keys(values).filter((k) => FIELD[k]);
  if (!keys.length) return;
  db.prepare(`UPDATE guests SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => values[k]), guestId);
}

// Human-readable value for CSV / tables.
function display(f, g, hotelsById) {
  const v = g[f.key];
  if (v == null || v === '') return '';
  if (f.type === 'hotel') return hotelsById.get(v) || '';
  if (f.options === YESNO) return v ? 'Yes' : 'No';
  if (f.type === 'date') return v;
  return v;
}

// ---- Custom fields ----
const customFields = (eventId) => db.prepare('SELECT * FROM custom_fields WHERE event_id = ? ORDER BY sort, id').all(eventId);
const customValues = (guestId) => new Map(db.prepare('SELECT field_id, value FROM guest_custom WHERE guest_id = ?').all(guestId).map((r) => [r.field_id, r.value]));

function customInput(cf, value) {
  const name = `cf_${cf.id}`, v = value ?? '';
  if (cf.type === 'select') {
    const options = ['', ...String(cf.options || '').split(',').map((s) => s.trim()).filter(Boolean)];
    return html`<select name="${name}">${options.map((o) => html`<option ${o === v ? 'selected' : ''}>${o}</option>`)}</select>`;
  }
  if (cf.type === 'yesno') return html`<select name="${name}"><option></option><option ${v === 'Yes' ? 'selected' : ''}>Yes</option><option ${v === 'No' ? 'selected' : ''}>No</option></select>`;
  return html`<input type="${{ number: 'number', date: 'date' }[cf.type] || 'text'}" name="${name}" value="${v}">`;
}

function saveCustom(guestId, fields, body) {
  const up = db.prepare(`INSERT INTO guest_custom (guest_id, field_id, value) VALUES (?,?,?)
    ON CONFLICT (guest_id, field_id) DO UPDATE SET value = excluded.value`);
  for (const cf of fields) {
    const k = `cf_${cf.id}`;
    if (k in body) up.run(guestId, cf.id, String(body[k] ?? '').trim().slice(0, 500) || null);
  }
}

module.exports = { GUEST_FIELDS, FIELD, SECTIONS, hotelsOf, input, formSection, parse, update, display, customFields, customValues, customInput, saveCustom, fmtDate };
