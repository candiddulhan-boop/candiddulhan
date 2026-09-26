// Bulk upload of guests from Excel (.xlsx) or CSV: adds new guests, updates existing ones (matched by mobile,
// or by name when there is no mobile), creates hotels and family members, and invites to functions.
const ExcelJS = require('exceljs');
const db = require('./db');
const F = require('./fields');
const W = require('./wedding');
const { parseCsv, token, phoneKey } = require('./util');

const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Header aliases → our field keys (in addition to every built-in field's key and label).
const ALIASES = {
  name: ['name', 'guestname', 'fullname', 'guest'],
  phone: ['phone', 'mobile', 'whatsapp', 'phonenumber', 'contact', 'mobilenumber', 'mobilewhatsapp'],
  group_name: ['group', 'groupname', 'relationgroup'],
  max_pax: ['maxpax', 'pax', 'people', 'count', 'guests', 'members', 'invitedfor', 'invitedforpeople', 'noofpeople'],
  functions: ['functions', 'invitedto', 'events', 'function'],
  family: ['familymembers', 'family', 'membersnames', 'accompaniedby'],
  hotel: ['hotel', 'hotelname'],
};

function columnMap(header, customFields) {
  const map = {};
  header.forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    for (const [key, names] of Object.entries(ALIASES)) if (names.includes(n) && !(key in map)) map[key] = i;
    for (const f of F.GUEST_FIELDS) if ((norm(f.key) === n || norm(f.label) === n) && !(f.key in map) && f.key !== 'hotel_id') map[f.key] = i;
    for (const cf of customFields) if (norm(cf.label) === n) map[`cf_${cf.id}`] = i;
  });
  return map;
}

// Cell → string. Excel dates/times arrive as Date objects.
function cellText(v, key) {
  if (v == null) return '';
  if (v instanceof Date) {
    if (/time/.test(key || '')) return v.toISOString().slice(11, 16);
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'object') {
    if ('text' in v) return String(v.text); // hyperlink / rich text
    if ('result' in v) return cellText(v.result, key); // formula
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
  }
  return String(v).trim();
}

async function readRows(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.xlsx') || file.mimetype?.includes('spreadsheetml')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer);
    const ws = wb.worksheets.find((w) => /guest/i.test(w.name)) || wb.worksheets[0];
    if (!ws) return [];
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1)));
    return rows;
  }
  if (name.endsWith('.xls')) throw new Error('Old .xls files aren’t supported — in Excel choose File → Save As → Excel Workbook (.xlsx).');
  return parseCsv(file.buffer.toString('utf8'));
}

// The template's example rows — ignored if the planner forgets to delete them.
const EXAMPLES = new Set(['Mehta Family|9876543210', 'Dr. Rao|9123456780']);

const YES = new Set(['yes', 'y', '1', 'true', 'haan', 'ha']);
const NO = new Set(['no', 'n', '0', 'false', 'nahi']);
function toFieldValue(key, text) {
  const f = F.FIELD[key];
  if (!f) return text;
  if (f.options && f.options.some(([k]) => k === '1')) { // yes/no fields
    const t = text.toLowerCase();
    return YES.has(t) ? '1' : NO.has(t) ? '0' : '';
  }
  if (key === 'side') return /^b/i.test(text) ? 'Bride' : /^g/i.test(text) ? 'Groom' : /^both/i.test(text) ? 'Both' : text;
  if (f.type === 'select') {
    const hit = f.options.find(([k]) => k.toLowerCase() === text.toLowerCase());
    return hit ? hit[0] : text;
  }
  if (f.type === 'date') {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text); // 10/12/2026 → Indian day-first
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return text;
}

// "Sunita (Wife); Aryan (Son, Child)" → [{name, relation, age_group}]
function parseFamily(text) {
  return text.split(/[;\n]|,(?![^()]*\))/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^(.*?)\s*\((.*)\)\s*$/.exec(s);
    const name = (m ? m[1] : s).trim().slice(0, 80);
    const bits = m ? m[2].split(',').map((x) => x.trim()) : [];
    const age = bits.find((b) => /^(adult|child|kid|senior)$/i.test(b));
    return {
      name,
      relation: bits.filter((b) => b !== age).join(', ').slice(0, 60) || null,
      age_group: age ? (/kid|child/i.test(age) ? 'Child' : /senior/i.test(age) ? 'Senior' : 'Adult') : null,
    };
  }).filter((m) => m.name);
}

async function importGuests(e, file, { update = true, who } = {}) {
  const rows = await readRows(file);
  if (rows.length < 2) return { error: 'The file is empty — it needs a header row and at least one guest.' };
  const customFields = F.customFields(e.id);
  const header = rows[0].map((h) => cellText(h));
  const col = columnMap(header, customFields);
  if (!('name' in col)) return { error: 'No “Name” column found. Download the template to see the expected columns.' };

  const fns = W.functionsOf(e.id);
  const existing = db.prepare('SELECT id, name, phone FROM guests WHERE event_id = ?').all(e.id);
  const byPhone = new Map(existing.filter((g) => phoneKey(g.phone).length >= 10).map((g) => [phoneKey(g.phone), g.id]));
  const byName = new Map(existing.map((g) => [g.name.trim().toLowerCase(), g.id]));
  const hotels = new Map(db.prepare('SELECT id, name FROM hotels WHERE event_id = ?').all(e.id).map((h) => [h.name.toLowerCase(), h.id]));
  const fieldKeys = Object.keys(col).filter((k) => F.FIELD[k] && k !== 'name');
  const cfKeys = Object.keys(col).filter((k) => k.startsWith('cf_'));
  const res = { added: 0, updated: 0, skipped: [], members: 0, hotelsCreated: 0, seenPhones: new Set() };

  db.exec('BEGIN');
  try {
    rows.slice(1).forEach((row, i) => {
      const line = i + 2;
      const get = (k) => (k in col ? cellText(row[col[k]], k) : '');
      const name = get('name').slice(0, 120);
      if (!name) { if (row.some((c) => cellText(c))) res.skipped.push(`Row ${line}: no name`); return; }
      const phone = get('phone');
      const key = phoneKey(phone);
      if (EXAMPLES.has(`${name}|${key}`)) { res.skipped.push(`Row ${line}: template example row`); return; }
      if (phone && key.length < 10) { res.skipped.push(`Row ${line} (${name}): mobile “${phone}” looks incomplete`); return; }
      if (key && res.seenPhones.has(key)) { res.skipped.push(`Row ${line} (${name}): same mobile as an earlier row`); return; }
      if (key) res.seenPhones.add(key);

      let gid = (key && byPhone.get(key)) || (!key && byName.get(name.toLowerCase())) || null;
      const isNew = !gid;
      if (!isNew && !update) { res.skipped.push(`Row ${line} (${name}): already on the list`); return; }
      if (isNew) {
        gid = Number(db.prepare('INSERT INTO guests (event_id, name, phone, token) VALUES (?,?,?,?)').run(e.id, name, phone || null, token()).lastInsertRowid);
        if (key) byPhone.set(key, gid);
        byName.set(name.toLowerCase(), gid);
        res.added++;
      } else {
        db.prepare('UPDATE guests SET name = ? WHERE id = ?').run(name, gid);
        res.updated++;
      }

      // Built-in fields: only non-empty cells overwrite.
      const body = {};
      for (const k of fieldKeys) { const t = get(k); if (t !== '') body[k] = toFieldValue(k, t); }
      const hotelName = get('hotel');
      if (hotelName) {
        let hid = hotels.get(hotelName.toLowerCase());
        if (!hid) {
          hid = Number(db.prepare('INSERT INTO hotels (event_id, name) VALUES (?,?)').run(e.id, hotelName.slice(0, 120)).lastInsertRowid);
          hotels.set(hotelName.toLowerCase(), hid);
          res.hotelsCreated++;
        }
        body.hotel_id = String(hid);
      }
      const vals = F.parse(body, Object.keys(body));
      for (const k of Object.keys(vals)) if (vals[k] == null) delete vals[k];
      F.update(gid, vals);
      if (cfKeys.length) F.saveCustom(gid, customFields.filter((cf) => cfKeys.includes(`cf_${cf.id}`) && get(`cf_${cf.id}`) !== ''),
        Object.fromEntries(cfKeys.map((k) => [k, get(k)])));

      // Functions: listed ones (or all, for new guests when the column is empty).
      const wanted = get('functions') ? get('functions').toLowerCase().split(/[,;/]/).map((x) => x.trim()).filter(Boolean) : null;
      if (wanted?.includes('all')) W.inviteGuest(gid, fns.map((f) => f.id));
      else if (wanted) W.inviteGuest(gid, fns.filter((f) => wanted.includes(f.name.toLowerCase())).map((f) => f.id));
      else if (isNew) W.inviteGuest(gid, fns.map((f) => f.id));

      // Family members not already recorded.
      const fam = get('family');
      if (fam) {
        const have = new Set(W.membersOf(gid).map((m) => m.name.toLowerCase()));
        let sort = have.size;
        for (const m of parseFamily(fam)) {
          if (have.has(m.name.toLowerCase())) continue;
          db.prepare('INSERT INTO guest_members (guest_id, name, relation, age_group, sort) VALUES (?,?,?,?,?)').run(gid, m.name, m.relation, m.age_group, sort++);
          res.members++;
        }
        const count = W.membersOf(gid).length + 1;
        db.prepare('UPDATE guests SET max_pax = MAX(max_pax, ?) WHERE id = ?').run(count, gid);
      }
    });
    if (res.added || res.updated) {
      db.prepare('INSERT INTO activities (event_id, actor, kind, detail) VALUES (?,?,?,?)')
        .run(e.id, who || null, 'import', `Bulk upload: ${res.added} added, ${res.updated} updated${res.members ? `, ${res.members} family members` : ''}`);
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  delete res.seenPhones;
  return res;
}

// Downloadable Excel template with dropdowns, example rows and instructions.
async function template(e) {
  const fns = W.functionsOf(e.id);
  const cfs = F.customFields(e.id);
  const cols = [
    ['Name', 26, 'Mehta Family'], ['Mobile (WhatsApp)', 18, '9876543210'], ['Salutation', 12, 'Mr.'], ['Side', 10, 'Bride'],
    ['Relation to couple', 20, 'Mama ji'], ['Group', 14, 'Family'], ['Category', 12, 'VIP'], ['City', 14, 'Delhi'], ['Preferred language', 14, 'Hindi'],
    ['Invited for (people)', 12, 4], ['Children in party', 12, 1], ['Functions', 26, fns.length ? fns.map((f) => f.name).slice(-3).join(', ') : 'all'],
    ['Family members', 36, 'Sunita (Wife); Aryan (Son, Child); Kamla (Mother, Senior)'], ['Email', 22, ''],
    ['Arrival date', 13, '2026-12-10'], ['Arrival time', 11, '09:40'], ['Arriving by', 12, 'Flight'], ['Flight / train no.', 14, '6E 2134'],
    ['Pickup needed', 12, 'Yes'], ['Departure date', 13, '2026-12-14'], ['Needs accommodation', 14, 'Yes'], ['Hotel', 20, ''],
    ['Room type', 12, 'Triple'], ['Food preference', 16, 'Jain'], ['Special needs', 22, 'Wheelchair for Mother'],
    ...cfs.map((cf) => [cf.label, 18, '']),
  ];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Guests', { properties: { tabColor: { argb: 'FF8C1C3A' } } });
  ws.columns = cols.map(([header, width]) => ({ header, width }));
  ws.addRow(cols.map(([, , ex]) => ex));
  ws.addRow(['Dr. Rao', '9123456780', 'Dr.', 'Groom', 'Boss', 'Office', '', 'Mumbai', 'English', 2, 0, 'Wedding, Reception']);
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8C1C3A' } };
  head.height = 30;
  head.alignment = { vertical: 'middle', wrapText: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of [2, 3]) ws.getRow(r).font = { italic: true, color: { argb: 'FF7A6A64' } };
  const list = (name, values) => {
    const i = cols.findIndex(([h]) => h === name) + 1;
    if (i > 0) ws.dataValidations.add(`${ws.getColumn(i).letter}2:${ws.getColumn(i).letter}2000`, { type: 'list', allowBlank: true, formulae: [`"${values.join(',')}"`] });
  };
  list('Side', ['Bride', 'Groom', 'Both']);
  list('Category', ['VIP', 'Family', 'Friends', 'Office', 'Neighbours', 'Vendor', 'Other']);
  list('Arriving by', ['Flight', 'Train', 'Car', 'Bus', 'Local']);
  list('Pickup needed', ['Yes', 'No']);
  list('Needs accommodation', ['Yes', 'No']);
  list('Food preference', ['Vegetarian', 'Non-vegetarian', 'Jain', 'Vegan', 'Eggetarian', 'Other']);
  list('Room type', ['Single', 'Double', 'Twin', 'Triple', 'Suite', 'Villa', 'Dormitory']);
  list('Salutation', ['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Shri', 'Smt.', 'Family']);

  const help = wb.addWorksheet('How to fill');
  help.getColumn(1).width = 110;
  [
    `Guest list template — ${e.title}`,
    '',
    '• One row per family / party. Only “Name” is required; fill whatever else you know.',
    '• Rows 2–3 are examples — replace or delete them.',
    '• Mobile: 10-digit Indian number (with or without +91). It is used for WhatsApp and to recognise the guest when you upload again.',
    '• Upload again any time: guests are matched by mobile and updated — filled cells overwrite, empty cells keep what is saved.',
    `• Functions: comma separated names${fns.length ? ` (${fns.map((f) => f.name).join(', ')})` : ''}, or “all”. Empty = all functions for new guests.`,
    '• Family members: separate with “;”. Add relation and age group in brackets, e.g. Aryan (Son, Child).',
    '• Dates: YYYY-MM-DD or DD/MM/YYYY. Yes/No columns accept Yes/No.',
    '• Hotel: type the hotel name — it is created automatically if new.',
    '• Do not put Aadhaar/PAN numbers here — guests upload IDs securely from their RSVP link.',
  ].forEach((t, i) => { const r = help.addRow([t]); if (i === 0) r.font = { bold: true, size: 14, color: { argb: 'FF8C1C3A' } }; });
  return wb.xlsx.writeBuffer();
}

module.exports = { importGuests, template, parseFamily, readRows };
