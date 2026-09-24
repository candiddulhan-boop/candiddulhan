const crypto = require('node:crypto');

const token = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Tagged template that escapes interpolations unless they are wrapped with raw().
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const html = (strings, ...vals) =>
  raw(strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = vals[i - 1];
    const str = Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('')
      : v instanceof Raw ? v.s : v === false || v == null ? '' : esc(v);
    return out + str + s;
  }, ''));

// Normalise Indian-style numbers to digits with country code, e.g. "098765 43210" -> "919876543210".
function normPhone(p, defaultCc = '91') {
  let d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  d = d.replace(/^00/, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = defaultCc + d;
  return d;
}
const phoneKey = (p) => normPhone(p).slice(-10);

function maskId(n) {
  const s = String(n || '');
  if (s.length <= 4) return s ? '****' : '';
  return '•'.repeat(Math.min(8, s.length - 4)) + s.slice(-4);
}

// Minimal RFC-4180 CSV parser (handles quotes, commas and newlines in quoted fields).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const csvCell = (v) => {
  let s = String(v ?? '');
  // avoid spreadsheet formula injection, but leave phone numbers like +91 98765 43210 alone
  if (/^[=@\t\r]/.test(s) || /^[+\-](?![\d\s()-]+$)/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const fmtDate = (d) => {
  if (!d) return '';
  const dt = new Date(d.includes('T') || d.length <= 10 ? d : d.replace(' ', 'T') + 'Z');
  if (isNaN(dt)) return d;
  return d.length <= 10
    ? dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : dt.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
      ...(dt.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
};

const fmtDuration = (s) => (s == null || s === '' ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

module.exports = { token, esc, html, raw, normPhone, phoneKey, maskId, parseCsv, toCsv, fmtDate, fmtDuration };
