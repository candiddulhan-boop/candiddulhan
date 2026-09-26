const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');

const COOKIE = 'cd_session';
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

// Persist a generated secret so sessions survive restarts when SESSION_SECRET isn't set.
function loadSecret() {
  if (config.sessionSecret) return config.sessionSecret;
  const file = path.join(config.dataDir, '.session-secret');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}
const secret = loadSecret();

const sign = (v) => crypto.createHmac('sha256', secret).update(v).digest('base64url');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  return !!(salt && hash) && safeEqual(crypto.scryptSync(String(pw), salt, 32).toString('hex'), hash);
}

// Team members log in with their email/phone + own password. The ADMIN_PASSWORD (owner) and
// optional shared CALLER_PASSWORD still work with any name, so the app is usable before accounts exist.
function authenticate(login, password, name) {
  if (!password) return null;
  const u = login && db.prepare('SELECT * FROM users WHERE login = ? AND active = 1').get(String(login).trim());
  if (u) return checkPassword(password, u.pass_hash) ? { uid: u.id, role: u.role, name: u.name } : null;
  // Owner / shared passwords always sign in to the Candid Dulhan (platform) workspace.
  const fallback = (name || login || '').trim().slice(0, 40);
  if (safeEqual(password, config.adminPassword)) return { uid: null, role: 'admin', name: fallback || 'Admin', org_id: db.platformOrgId };
  if (config.callerPassword && safeEqual(password, config.callerPassword)) return { uid: null, role: 'caller', name: fallback || 'Caller', org_id: db.platformOrgId };
  return null;
}

function login(res, { uid, role, name }) {
  const payload = Buffer.from(JSON.stringify({ uid, role, name, exp: Date.now() + MAX_AGE_MS })).toString('base64url');
  const secure = config.baseUrl.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_MS / 1000}${secure}`);
}

function logout(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function session(req, _res, next) {
  const raw = parseCookies(req)[COOKIE];
  req.user = null;
  if (raw) {
    const [payload, sig] = raw.split('.');
    if (payload && sig && safeEqual(sig, sign(payload))) {
      try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (data.exp > Date.now()) {
          if (data.uid) {
            // Re-check the account so deactivation / role changes take effect immediately.
            const u = db.prepare(`SELECT u.id, u.name, u.role, u.org_id, o.name org_name, o.is_platform
              FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = ? AND u.active = 1`).get(data.uid);
            if (u) req.user = { uid: u.id, role: u.role, name: u.name, org_id: u.org_id, org_name: u.org_name, platform: !!u.is_platform };
          } else {
            const o = db.prepare('SELECT name FROM orgs WHERE id = ?').get(db.platformOrgId);
            req.user = { uid: null, role: data.role, name: data.name, org_id: db.platformOrgId, org_name: o.name, platform: true };
          }
        }
      } catch {}
    }
  }
  next();
}

const requireRole = (...roles) => (req, res, next) => {
  if (req.user && roles.includes(req.user.role)) return next();
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
};

function requireApiKey(req, res, next) {
  const key = req.get('x-api-key') || req.query.key;
  if (config.apiKey && key && safeEqual(key, config.apiKey)) return next();
  res.status(401).json({ error: 'Invalid or missing API key (set API_KEY on the server)' });
}

module.exports = { session, login, logout, authenticate, hashPassword, requireRole, requireApiKey, safeEqual, sign };
