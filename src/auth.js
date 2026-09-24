const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

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

function roleFor(password) {
  if (password && safeEqual(password, config.adminPassword)) return 'admin';
  if (config.callerPassword && password && safeEqual(password, config.callerPassword)) return 'caller';
  return null;
}

function login(res, role, name) {
  const payload = Buffer.from(JSON.stringify({ role, name: name || role, exp: Date.now() + MAX_AGE_MS })).toString('base64url');
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
        if (data.exp > Date.now()) req.user = data;
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

module.exports = { session, login, logout, roleFor, requireRole, requireApiKey, safeEqual };
