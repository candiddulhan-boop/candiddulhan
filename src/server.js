const path = require('node:path');
const express = require('express');
const config = require('./config');
require('./db');
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
  </form>` });

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
}

module.exports = app;
