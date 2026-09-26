// Downloadable reports: a multi-sheet Excel workbook and branded PDF reports.
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const db = require('./db');
const S = require('./shared');
const W = require('./wedding');
const F = require('./fields');
const Smart = require('./smart');
const { fmtDate, maskId } = require('./util');

const BRAND = '8C1C3A', GOLD = 'B08A3E', INK = '2B1D1A', MUTED = '7A6A64', LINE = 'EADFD6';
const STATUS_FILL = { Attending: 'E3F4EA', Declined: 'FBE7E5', Maybe: 'FBF1D6', Awaiting: 'EFEBE8' };

function eventMeta(eventId) {
  return db.prepare('SELECT e.*, o.name org_name, o.is_platform FROM events e JOIN orgs o ON o.id = e.org_id WHERE e.id = ?').get(eventId);
}

// ---- data shared by both formats ----
const roomingRows = (eventId) => db.prepare(`SELECT g.*, h.name hotel_name FROM guests g LEFT JOIN hotels h ON h.id = g.hotel_id
  WHERE g.event_id = ? AND g.rsvp_status IN ('yes','maybe') AND (g.needs_stay = 1 OR g.hotel_id IS NOT NULL)
  ORDER BY h.name IS NULL, h.name, g.room_no, g.name`).all(eventId);
const travelRows = (eventId, dir) => db.prepare(`SELECT g.*, h.name hotel_name FROM guests g LEFT JOIN hotels h ON h.id = g.hotel_id
  WHERE g.event_id = ? AND g.rsvp_status IN ('yes','maybe') AND g.${dir}_date IS NOT NULL AND g.${dir}_date != ''
  ORDER BY g.${dir}_date, COALESCE(g.${dir}_time, '99'), g.name`).all(eventId);
const people = (g) => g.pax ?? g.max_pax;

// =====================================================================
// Excel
// =====================================================================
function styleSheet(ws, { widths = {} } = {}) {
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${BRAND}` } };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 28;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (ws.rowCount > 1) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  ws.columns.forEach((c) => {
    const key = c.header;
    c.width = widths[key] || Math.min(40, Math.max(10, String(key || '').length + 2));
  });
}

function addTable(wb, name, headers, rows, opts = {}) {
  const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: `FF${opts.tab || GOLD}` } } });
  ws.columns = headers.map((h) => ({ header: h }));
  for (const r of rows) ws.addRow(r);
  styleSheet(ws, opts);
  if (opts.statusCol) {
    ws.getColumn(opts.statusCol).eachCell((cell, i) => {
      if (i > 1 && STATUS_FILL[cell.value]) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${STATUS_FILL[cell.value]}` } };
    });
  }
  return ws;
}

async function excel(eventId, { forClient = false } = {}) {
  const e = eventMeta(eventId);
  const st = S.stats(eventId);
  const fns = W.functionStats(eventId);
  const answers = W.guestFunctionMap(eventId);
  const hotels = new Map(db.prepare('SELECT id, name FROM hotels WHERE event_id = ?').all(eventId).map((h) => [h.id, h.name]));
  const guests = db.prepare('SELECT * FROM guests WHERE event_id = ? ORDER BY side, group_name, name').all(eventId);
  const wb = new ExcelJS.Workbook();
  wb.creator = e.is_platform ? 'Candid Dulhan RSVP' : `${e.org_name} · Candid Dulhan RSVP`;
  wb.created = new Date();

  // Summary
  const sum = wb.addWorksheet('Summary', { properties: { tabColor: { argb: `FF${BRAND}` } } });
  sum.columns = [{ width: 34 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }];
  sum.addRow([e.title]).font = { bold: true, size: 18, color: { argb: `FF${BRAND}` } };
  sum.addRow([[fmtDate(e.event_date), e.venue, e.city].filter(Boolean).join(' · ')]).font = { color: { argb: `FF${MUTED}` } };
  sum.addRow([`Prepared by ${e.is_platform ? 'Candid Dulhan' : e.org_name} on ${fmtDate(new Date().toISOString())}`]).font = { italic: true, color: { argb: `FF${MUTED}` } };
  sum.addRow([]);
  const kpis = [['Guest parties', st.total], ['Invites sent', st.invited], ['Responded', st.total - st.pending], ['Attending parties', st.yes],
    ['People attending', st.pax], ['Declined', st.no], ['Maybe', st.maybe], ['Awaiting reply', st.pending], ['IDs collected', st.ids],
    ['Need stay', st.stay], ['Calls logged', st.calls]];
  for (const [k, v] of kpis) {
    const r = sum.addRow([k, v]);
    r.getCell(1).font = { color: { argb: `FF${MUTED}` } };
    r.getCell(2).font = { bold: true, size: 12 };
  }
  if (fns.length) {
    sum.addRow([]);
    const h = sum.addRow(['Function', 'Date', 'Invited', 'Attending', 'People', 'Awaiting']);
    h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${BRAND}` } }; });
    for (const f of fns) sum.addRow([f.name, [f.date, f.time].filter(Boolean).join(' '), f.invited, f.yes || 0, f.people, f.pending || 0]);
  }
  const alerts = Smart.alerts(e);
  if (alerts.length && !forClient) {
    sum.addRow([]);
    sum.addRow(['Needs attention']).font = { bold: true, size: 12, color: { argb: `FF${BRAND}` } };
    for (const a of alerts) sum.addRow([`${a.level.toUpperCase()}: ${a.title}`, a.detail]);
  }

  // Guests — every field
  const fields = F.GUEST_FIELDS.filter((f) => !(forClient && f.key === 'internal_notes'));
  const statusLabel = (x) => S.STATUS_LABEL[x] || x;
  addTable(wb, 'Guests',
    [...fields.map((f) => f.label), 'RSVP', 'People attending', ...fns.map((f) => f.name), 'ID', 'Other documents', 'Responded'],
    guests.map((g) => [...fields.map((f) => F.display(f, g, hotels)), statusLabel(g.rsvp_status), g.pax,
      ...fns.map((f) => { const a = answers.get(g.id)?.get(f.id); return a ? statusLabel(a.rsvp) : '—'; }),
      g.id_file ? `${g.id_type || 'ID'} ${maskId(g.id_number)}` : g.id_type ? `${g.id_type} (no photo)` : '',
      db.prepare('SELECT doc_type, number FROM id_documents WHERE guest_id = ? AND member_id IS NULL').all(g.id).map((d) => `${d.doc_type} ${maskId(d.number) || ''}`.trim()).join('; '),
      g.responded_at || '']),
    { statusCol: fields.length + 1, widths: { Name: 26, 'Relation to couple': 18, 'Guest’s message': 30, 'Internal notes (team only)': 30 } });

  // Function-wise headcount per guest
  if (fns.length) {
    addTable(wb, 'Functions', ['Guest', 'Side', 'Group', ...fns.flatMap((f) => [f.name, `${f.name} people`])],
      guests.map((g) => [g.name, g.side, g.group_name, ...fns.flatMap((f) => {
        const a = answers.get(g.id)?.get(f.id);
        return a ? [statusLabel(a.rsvp), a.rsvp === 'yes' ? a.pax ?? 1 : ''] : ['Not invited', ''];
      })]), { widths: { Guest: 26 } });
  }

  // Family members
  const members = db.prepare(`SELECT m.*, g.name guest_name FROM guest_members m JOIN guests g ON g.id = m.guest_id
    WHERE g.event_id = ? ORDER BY g.name, m.sort`).all(eventId);
  if (members.length) {
    addTable(wb, 'Family members', ['Guest (head of party)', 'Member', 'Relation', 'Age group', 'Food', 'ID'],
      members.map((m) => [m.guest_name, m.name, m.relation, m.age_group, m.dietary, m.id_file ? `${m.id_type || 'ID'} ${maskId(m.id_number)}` : m.id_type || '']),
      { widths: { 'Guest (head of party)': 26, Member: 24 } });
  }

  addTable(wb, 'Rooming', ['Hotel', 'Room type', 'Room no.', 'Guest', 'People', 'Kids', 'Check-in', 'Check-out', 'Sharing with', 'Special needs'],
    roomingRows(eventId).map((g) => [g.hotel_name || 'UNASSIGNED', g.room_type, g.room_no, g.name, people(g), g.kids,
      g.check_in || g.arrival_date, g.check_out || g.departure_date, g.sharing_with, g.special_needs]), { widths: { Hotel: 24, Guest: 26 } });
  addTable(wb, 'Arrivals', ['Date', 'Time', 'Guest', 'People', 'Mode', 'Flight/train', 'Arriving at', 'Hotel', 'Pickup needed', 'Pickup status', 'Vehicle / driver'],
    travelRows(eventId, 'arrival').map((g) => [g.arrival_date, g.arrival_time, g.name, people(g), g.arrival_mode, g.arrival_details, g.arrival_point,
      g.hotel_name, g.pickup_required == null ? '' : g.pickup_required ? 'Yes' : 'No', g.pickup_status, g.pickup_vehicle]), { widths: { Guest: 26, 'Vehicle / driver': 30 } });
  addTable(wb, 'Departures', ['Date', 'Time', 'Guest', 'People', 'Mode', 'Flight/train', 'Leaving from', 'Hotel', 'Drop needed', 'Drop status', 'Vehicle / driver'],
    travelRows(eventId, 'departure').map((g) => [g.departure_date, g.departure_time, g.name, people(g), g.departure_mode, g.departure_number,
      g.departure_point, g.hotel_name, g.drop_required == null ? '' : g.drop_required ? 'Yes' : 'No', g.drop_status, g.drop_vehicle]), { widths: { Guest: 26 } });

  // Food summary per function
  const diet = db.prepare(`SELECT COALESCE(NULLIF(dietary, ''), 'Not specified') diet, COUNT(*) parties, SUM(COALESCE(pax, max_pax)) people
    FROM guests WHERE event_id = ? AND rsvp_status = 'yes' GROUP BY 1 ORDER BY people DESC`).all(eventId);
  addTable(wb, 'Food', ['Food preference', 'Parties', 'People'], diet.map((d) => [d.diet, d.parties, d.people]), { widths: { 'Food preference': 24 } });

  const calls = S.eventCalls(eventId, 5000);
  addTable(wb, 'Calls', ['When', 'Guest', 'Outcome', 'By', 'Duration (min)', 'Notes', 'Recording'],
    calls.map((c) => [fmtDate(c.called_at), c.guest_name || c.phone, S.OUTCOMES[c.outcome] || c.outcome || '', c.caller,
      c.duration_sec ? +(c.duration_sec / 60).toFixed(1) : '', c.notes, c.recording_file ? 'Yes' : '']), { widths: { Notes: 40, Guest: 24 } });

  return wb.xlsx.writeBuffer();
}

// =====================================================================
// PDF
// =====================================================================
const hex = (h) => `#${h}`;

function pdfDoc(e, title) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `${title} — ${e.title}`, Author: e.is_platform ? 'Candid Dulhan' : e.org_name } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  // Header band
  doc.rect(0, 0, doc.page.width, 92).fill(hex(BRAND));
  doc.fill('#FFFFFF').font('Helvetica-Bold').fontSize(9).text((e.is_platform ? 'CANDID DULHAN' : e.org_name.toUpperCase()), 40, 22, { characterSpacing: 1.5 });
  doc.font('Times-Bold').fontSize(24).text(e.title, 40, 36);
  doc.font('Helvetica').fontSize(9).text(`${title}  ·  ${[fmtDate(e.event_date), e.venue, e.city].filter(Boolean).join(' · ')}`, 40, 66);
  doc.fill(hex(INK)).moveDown(3);
  doc.y = 110;
  return { doc, done };
}

function footer(doc, e) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing inside the margin must not trigger a new page
    doc.font('Helvetica').fontSize(7.5).fill(hex(MUTED))
      .text(`${e.is_platform ? 'Candid Dulhan RSVP' : `${e.org_name} · Powered by Candid Dulhan`}  ·  Generated ${fmtDate(new Date().toISOString())}  ·  Page ${i + 1} of ${range.count}  ·  Confidential`,
        40, doc.page.height - 30, { width: doc.page.width - 80, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
}

function heading(doc, text) {
  if (doc.y > doc.page.height - 120) doc.addPage();
  doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fill(hex(BRAND)).text(text, 40);
  doc.moveTo(40, doc.y + 2).lineTo(doc.page.width - 40, doc.y + 2).lineWidth(0.5).stroke(hex(GOLD));
  doc.moveDown(0.5).fill(hex(INK));
}

// Simple table with repeating header and zebra rows.
function table(doc, cols, rows, { fontSize = 8 } = {}) {
  const x0 = 40, width = doc.page.width - 80;
  const total = cols.reduce((n, c) => n + (c.w || 1), 0);
  const ws = cols.map((c) => ((c.w || 1) / total) * width);
  const drawHeader = () => {
    const y = doc.y;
    doc.rect(x0, y, width, 16).fill(hex(BRAND));
    let x = x0;
    doc.font('Helvetica-Bold').fontSize(fontSize).fill('#FFFFFF');
    cols.forEach((c, i) => { doc.text(c.label, x + 4, y + 4, { width: ws[i] - 8, lineBreak: false, ellipsis: true }); x += ws[i]; });
    doc.y = y + 16;
  };
  drawHeader();
  rows.forEach((r, ri) => {
    doc.font('Helvetica').fontSize(fontSize);
    const h = Math.max(14, ...r.map((v, i) => doc.heightOfString(String(v ?? ''), { width: ws[i] - 8 }) + 6));
    if (doc.y + h > doc.page.height - 50) { doc.addPage(); doc.y = 40; drawHeader(); }
    const y = doc.y;
    if (ri % 2) doc.rect(x0, y, width, h).fill('#FAF6F1');
    let x = x0;
    doc.fill(hex(INK));
    r.forEach((v, i) => { doc.font(cols[i].bold ? 'Helvetica-Bold' : 'Helvetica').text(String(v ?? ''), x + 4, y + 3, { width: ws[i] - 8 }); x += ws[i]; });
    doc.y = y + h;
  });
  doc.x = x0;
  doc.moveDown(0.3);
}

function kpiGrid(doc, items) {
  const perRow = 4, gap = 8, w = (doc.page.width - 80 - gap * (perRow - 1)) / perRow, h = 46;
  const y0 = doc.y; // text() moves doc.y, so lay tiles out from a fixed origin
  items.forEach(([label, value, sub], i) => {
    const col = i % perRow, row = Math.floor(i / perRow);
    const x = 40 + col * (w + gap), y = y0 + row * (h + gap);
    doc.roundedRect(x, y, w, h, 6).lineWidth(0.6).stroke(hex(LINE));
    doc.font('Helvetica-Bold').fontSize(16).fill(hex(INK)).text(String(value), x + 8, y + 7, { width: w - 16 });
    doc.font('Helvetica').fontSize(7.5).fill(hex(MUTED)).text(`${label}${sub ? ` · ${sub}` : ''}`, x + 8, y + 29, { width: w - 16, lineBreak: false, ellipsis: true });
  });
  doc.y = y0 + Math.ceil(items.length / perRow) * (h + gap);
  doc.x = 40;
  doc.fill(hex(INK));
}

function progressBar(doc, st) {
  const x = 40, w = doc.page.width - 80, y = doc.y, h = 8;
  const parts = [[st.yes, '2F8F5B'], [st.maybe, 'D4A017'], [st.no, 'C0392B'], [st.pending, 'B8AEA8']];
  let cx = x;
  for (const [n, c] of parts) { const pw = st.total ? (n / st.total) * w : 0; if (pw) doc.rect(cx, y, pw, h).fill(hex(c)); cx += pw; }
  doc.y = y + h + 4;
  doc.font('Helvetica').fontSize(7.5).fill(hex(MUTED)).text(`Attending ${st.yes}  ·  Maybe ${st.maybe}  ·  Declined ${st.no}  ·  Awaiting ${st.pending}`, x);
  doc.fill(hex(INK));
}

async function statusPdf(eventId, { forClient = false } = {}) {
  const e = eventMeta(eventId);
  const st = S.stats(eventId);
  const { doc, done } = pdfDoc(e, 'Guest status report');
  kpiGrid(doc, [['Guest parties', st.total, `${st.invited} invited`], ['Responded', `${st.total ? Math.round(((st.total - st.pending) / st.total) * 100) : 0}%`, `${st.total - st.pending} parties`],
    ['Attending', st.pax, `${st.yes} parties`], ['Awaiting reply', st.pending, `${st.maybe} maybe`],
    ['IDs collected', st.ids, `of ${st.yes} attending`], ['Need stay', st.stay], ['Declined', st.no], ['Calls made', st.calls, `${st.recordings} recorded`]]);
  progressBar(doc, st);

  const ai = Smart.latestSummary(eventId);
  if (ai) {
    heading(doc, 'Executive summary');
    doc.font('Helvetica-Bold').fontSize(10.5).text(ai.headline);
    doc.moveDown(0.3).font('Helvetica').fontSize(9.5).text(ai.summary, { lineGap: 2 });
    if (!forClient && ai.next_actions?.length) {
      doc.moveDown(0.5).font('Helvetica-Bold').fontSize(9.5).text('Next 48 hours');
      doc.font('Helvetica').fontSize(9).list(ai.next_actions, { bulletRadius: 1.5, textIndent: 10, lineGap: 1.5 });
    }
    if (ai.guest_experience_ideas?.length) {
      doc.moveDown(0.5).font('Helvetica-Bold').fontSize(9.5).text('Guest experience ideas');
      doc.font('Helvetica').fontSize(9).list(ai.guest_experience_ideas, { bulletRadius: 1.5, textIndent: 10, lineGap: 1.5 });
    }
    doc.font('Helvetica-Oblique').fontSize(7).fill(hex(MUTED)).text(`AI summary prepared ${fmtDate(ai.created_at)}`).fill(hex(INK));
  }

  const alerts = Smart.alerts(e);
  if (alerts.length) {
    heading(doc, forClient ? 'Being taken care of' : 'Needs attention');
    table(doc, [{ label: 'Priority', w: 0.8, bold: true }, { label: 'Item', w: 2.6 }, { label: 'Detail', w: 3.6 }],
      alerts.map((a) => [a.level === 'high' ? 'HIGH' : a.level === 'medium' ? 'Medium' : 'Low', a.title, a.detail]));
  }

  const fns = W.functionStats(eventId);
  if (fns.length) {
    heading(doc, 'Functions — headcount');
    table(doc, [{ label: 'Function', w: 1.6, bold: true }, { label: 'When', w: 1.6 }, { label: 'Venue', w: 1.8 }, { label: 'Invited', w: 0.8 },
      { label: 'Attending', w: 0.9 }, { label: 'People', w: 0.8, bold: true }, { label: 'Maybe', w: 0.7 }, { label: 'Awaiting', w: 0.9 }],
    fns.map((f) => [f.name, [fmtDate(f.date), f.time].filter(Boolean).join(' '), f.venue, f.invited, f.yes || 0, f.people, f.maybe || 0, f.pending || 0]));
  }
  const diet = db.prepare(`SELECT COALESCE(NULLIF(dietary, ''), 'Not specified') diet, SUM(COALESCE(pax, max_pax)) people
    FROM guests WHERE event_id = ? AND rsvp_status = 'yes' GROUP BY 1 ORDER BY people DESC`).all(eventId);
  if (diet.length) {
    heading(doc, 'Food preferences (attending)');
    table(doc, [{ label: 'Preference', w: 2, bold: true }, { label: 'People', w: 1 }], diet.map((d) => [d.diet, d.people]));
  }
  if (st.sides.length) {
    heading(doc, 'By side');
    table(doc, [{ label: 'Side', w: 2, bold: true }, { label: 'Guest parties', w: 1 }, { label: 'People attending', w: 1 }], st.sides.map((r) => [r.side, r.guests, r.pax]));
  }
  if (st.arrivals.length) {
    heading(doc, 'Arrivals by date');
    table(doc, [{ label: 'Date', w: 1.5, bold: true }, { label: 'Parties', w: 1 }, { label: 'People', w: 1 }], st.arrivals.map((r) => [fmtDate(r.arrival_date), r.parties, r.pax]));
  }
  if (!forClient) {
    const T = require('./tenancy');
    const team = S.teamStats(eventId, T.eventTeam(e));
    if (team.length) {
      heading(doc, 'Team performance');
      table(doc, [{ label: 'Team member', w: 2, bold: true }, { label: 'Assigned', w: 1 }, { label: 'Open', w: 1 }, { label: 'Confirmed', w: 1 },
        { label: 'Calls', w: 1 }, { label: 'Connected', w: 1 }, { label: 'Overdue', w: 1 }],
      team.map((t) => [t.name, t.assigned, t.open, t.confirmed, t.calls, t.connected, t.overdue]));
    }
  }
  footer(doc, e);
  doc.end();
  return done;
}

async function roomingPdf(eventId) {
  const e = eventMeta(eventId);
  const { doc, done } = pdfDoc(e, 'Rooming list');
  const rows = roomingRows(eventId);
  const byHotel = new Map();
  for (const g of rows) (byHotel.get(g.hotel_name || 'To be assigned') || byHotel.set(g.hotel_name || 'To be assigned', []).get(g.hotel_name || 'To be assigned')).push(g);
  if (!rows.length) doc.font('Helvetica').fontSize(10).text('No stays planned yet.');
  for (const [hotel, gs] of byHotel) {
    heading(doc, `${hotel} — ${gs.length} parties, ${gs.reduce((n, g) => n + people(g), 0)} people`);
    table(doc, [{ label: 'Room', w: 1.2, bold: true }, { label: 'Guest', w: 2.2 }, { label: 'People', w: 0.7 }, { label: 'Family members', w: 3 },
      { label: 'Check-in', w: 1.1 }, { label: 'Check-out', w: 1.1 }, { label: 'Notes', w: 1.7 }],
    gs.map((g) => [[g.room_type, g.room_no].filter(Boolean).join(' '), [g.salutation, g.name].filter(Boolean).join(' '), people(g),
      W.membersOf(g.id).map((m) => m.name).join(', '), fmtDate(g.check_in || g.arrival_date), fmtDate(g.check_out || g.departure_date),
      [g.special_needs, g.sharing_with && `shares with ${g.sharing_with}`].filter(Boolean).join('; ')]));
  }
  footer(doc, e);
  doc.end();
  return done;
}

async function transportPdf(eventId, dir = 'arrival') {
  const e = eventMeta(eventId);
  const p = dir === 'arrival' ? 'pickup' : 'drop';
  const { doc, done } = pdfDoc(e, dir === 'arrival' ? 'Arrivals & pickup sheet' : 'Departures & drop sheet');
  const rows = travelRows(eventId, dir);
  const byDate = new Map();
  for (const g of rows) (byDate.get(g[`${dir}_date`]) || byDate.set(g[`${dir}_date`], []).get(g[`${dir}_date`])).push(g);
  if (!rows.length) doc.font('Helvetica').fontSize(10).text(`No ${dir} details yet.`);
  for (const [date, gs] of byDate) {
    heading(doc, `${fmtDate(date)} — ${gs.reduce((n, g) => n + people(g), 0)} people`);
    table(doc, [{ label: 'Time', w: 0.7, bold: true }, { label: 'Guest', w: 2 }, { label: 'Pax', w: 0.5 }, { label: 'Travel', w: 1.8 },
      { label: dir === 'arrival' ? 'At' : 'From', w: 1.5 }, { label: 'Hotel', w: 1.5 }, { label: `${p === 'pickup' ? 'Pickup' : 'Drop'} · vehicle / driver`, w: 2.4 }],
    gs.map((g) => [g[`${dir}_time`] || '—', `${g.name}${g.phone ? `\n${g.phone}` : ''}`, people(g),
      [g[`${dir}_mode`], dir === 'arrival' ? g.arrival_details : g.departure_number].filter(Boolean).join(' '), g[`${dir}_point`], g.hotel_name,
      g[`${p}_required`] === 0 ? 'Not needed' : [g[`${p}_status`] || 'Pending', g[`${p}_vehicle`]].filter(Boolean).join(' · ')]));
  }
  footer(doc, e);
  doc.end();
  return done;
}

async function guestListPdf(eventId) {
  const e = eventMeta(eventId);
  const { doc, done } = pdfDoc(e, 'Guest list');
  const fns = W.functionsOf(eventId);
  const answers = W.guestFunctionMap(eventId);
  const guests = db.prepare('SELECT * FROM guests WHERE event_id = ? ORDER BY side, group_name, name').all(eventId);
  const mark = { yes: 'Y', no: 'N', maybe: '?', pending: '·' };
  table(doc, [{ label: 'Guest', w: 2.4, bold: true }, { label: 'Side / group', w: 1.6 }, { label: 'RSVP', w: 1 }, { label: 'Pax', w: 0.5 },
    ...(fns.length ? [{ label: fns.map((f) => f.name.slice(0, 3)).join(' '), w: 1.8 }] : []), { label: 'Arrival', w: 1.4 }, { label: 'Food', w: 1.1 }],
  guests.map((g) => [[g.salutation, g.name].filter(Boolean).join(' '), [g.side, g.group_name].filter(Boolean).join(' · '), S.STATUS_LABEL[g.rsvp_status],
    g.rsvp_status === 'yes' ? people(g) : '', ...(fns.length ? [fns.map((f) => mark[answers.get(g.id)?.get(f.id)?.rsvp] || '–').join('   ')] : []),
    [fmtDate(g.arrival_date), g.arrival_time].filter(Boolean).join(' '), g.dietary]), { fontSize: 7.5 });
  if (fns.length) doc.font('Helvetica').fontSize(7).fill(hex(MUTED)).text(`Functions: ${fns.map((f) => f.name).join(', ')}. Y attending · N declined · ? maybe · · awaiting · – not invited`);
  footer(doc, e);
  doc.end();
  return done;
}

module.exports = { excel, statusPdf, roomingPdf, transportPdf, guestListPdf };
