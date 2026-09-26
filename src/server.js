const path = require('node:path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const layout = require('./layout');
const { html } = require('./util');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
// PWA files must be served from the site root so the service worker controls every page.
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
});
app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, '..', 'public', 'manifest.webmanifest'));
});
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(auth.session);

app.get('/', (req, res) => res.redirect(req.user ? (req.user.role === 'admin' ? '/admin' : '/caller') : '/login'));

const loginPage = (req, error) => layout({ title: 'Log in', user: null, body: html`
  <form method="post" action="/login" class="form card login">
    <h1>Team login</h1>
    ${error ? html`<div class="flash warn">${error}</div>` : ''}
    <input type="hidden" name="next" value="${req.query.next || req.body?.next || ''}">
    <label>Email or phone<input name="login" autocomplete="username" autofocus></label>
    <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
    <details><summary class="muted small">Using the owner / shared password?</summary>
      <label>Your name <small>(shown on call logs)</small><input name="name" autocomplete="name"></label></details>
    <button class="primary">Log in</button>
    <p class="muted small center">Event management company? <a href="/signup">Create a free account</a></p>
  </form>` });

// Free self-serve accounts for event-management companies.
const signupPage = (req, error, b = {}) => layout({ title: 'Create free account', user: null, body: html`
  <form method="post" action="/signup" class="form card login signup">
    <p class="eyebrow">Free for event companies</p>
    <h1>Guest management for your weddings</h1>
    <p class="muted small">WhatsApp invites, RSVPs, travel &amp; ID collection, your own calling team, and a live dashboard for every client — free. Need extra hands? Hire the Candid Dulhan RSVP desk for any wedding.</p>
    ${error ? html`<div class="flash warn">${error}</div>` : ''}
    <label>Company name<input name="company" required value="${b.company || ''}" placeholder="Royal Knot Events"></label>
    <div class="row"><label>Your name<input name="name" required value="${b.name || ''}" autocomplete="name"></label>
      <label>City<input name="city" value="${b.city || ''}" placeholder="Jaipur"></label></div>
    <div class="row"><label>Mobile<input name="phone" required inputmode="tel" value="${b.phone || ''}" autocomplete="tel"></label>
      <label>Email<input type="email" name="email" value="${b.email || ''}" autocomplete="email"></label></div>
    <label>Password <small>(6+ characters)</small><input type="password" name="password" required minlength="6" autocomplete="new-password"></label>
    <p class="muted small">You’ll log in with your email (or mobile if you leave email empty).</p>
    <button class="primary big">Create free account</button>
    <p class="muted small center">Already have an account? <a href="/login">Log in</a></p>
  </form>` });

app.get('/signup', (req, res) => res.send(signupPage(req)));
app.post('/signup', (req, res) => {
  const b = req.body;
  const clean = (v, n = 120) => String(v || '').trim().slice(0, n);
  const company = clean(b.company), name = clean(b.name, 60), phone = clean(b.phone, 20), email = clean(b.email).toLowerCase();
  if (!company || !name || !phone || String(b.password || '').length < 6) return res.status(400).send(signupPage(req, 'Please fill company, name, mobile and a 6+ character password.', b));
  const login = email || phone;
  if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) return res.status(400).send(signupPage(req, 'An account with that email/mobile already exists — log in instead.', b));
  let uid;
  db.exec('BEGIN');
  try {
    const org = db.prepare('INSERT INTO orgs (name, contact_name, phone, email, city) VALUES (?,?,?,?,?)').run(company, name, phone, email || null, clean(b.city, 60) || null);
    uid = Number(db.prepare("INSERT INTO users (name, login, role, pass_hash, org_id) VALUES (?,?, 'admin', ?,?)")
      .run(name, login, auth.hashPassword(b.password), org.lastInsertRowid).lastInsertRowid);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  auth.login(res, { uid, role: 'admin', name });
  res.redirect('/admin?msg=' + encodeURIComponent(`Welcome, ${name}! Create your first wedding below.`));
});

app.get('/login', (req, res) => res.send(loginPage(req)));
app.post('/login', (req, res) => {
  const user = auth.authenticate(req.body.login, req.body.password, req.body.name);
  if (!user) return res.status(401).send(loginPage(req, 'Wrong login or password'));
  auth.login(res, user);
  const role = user.role;
  const next = req.body.next || '';
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : null;
  res.redirect(safeNext && (role === 'admin' || safeNext.startsWith('/caller')) ? safeNext : role === 'admin' ? '/admin' : '/caller');
});
app.post('/logout', (_req, res) => { auth.logout(res); res.redirect('/login'); });

app.use('/api', require('./routes/api'));
app.use(require('./routes/smart').router);
app.use(require('./routes/wa').router);
app.use(require('./routes/automation').router);
app.use('/admin', require('./routes/ops'));
app.use('/admin', require('./routes/admin'));
app.use('/caller', require('./routes/caller'));
app.use('/i', require('./routes/rsvp'));
app.use('/c/:ctoken', require('./routes/client'));

app.use((_req, res) => res.status(404).send('Not found'));
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).send(`File too large (max ${config.maxUploadMb} MB). Please go back and choose a smaller file.`);
  console.error(err);
  res.status(500).send('Something went wrong');
});

if (require.main === module) {
  if (config.adminPassword === 'admin') console.warn('⚠  ADMIN_PASSWORD is not set — using "admin". Set it before going live.');
  app.listen(config.port, () => console.log(`Candid Dulhan RSVP running on http://localhost:${config.port}`));
  require('./automation').start();
}

module.exports = app;
