// Shared test helpers: boots the app on a temp database and gives a cookie-keeping HTTP client.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsvp-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_PASSWORD = 'owner-pass';
  process.env.API_KEY = 'test-key';
  const app = require('../src/server');
  const db = require('../src/db');
  const ctx = { db, base: '' };
  ctx.start = async () => {
    ctx.server = app.listen(0);
    await new Promise((r) => ctx.server.once('listening', r));
    ctx.base = `http://127.0.0.1:${ctx.server.address().port}`;
  };
  ctx.stop = () => { ctx.server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  ctx.client = () => {
    let cookie = '';
    const req = async (method, url, form) => {
      const isMultipart = form instanceof FormData;
      const res = await fetch(ctx.base + url, {
        method, redirect: 'manual',
        headers: { cookie, ...(form && !isMultipart ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? (isMultipart ? form : new URLSearchParams(form).toString()) : undefined,
      });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';');
        const [k] = pair.split('=');
        cookie = [...cookie.split('; ').filter((x) => x && !x.startsWith(`${k}=`)), pair].join('; ');
      }
      return { status: res.status, location: res.headers.get('location') || '', text: await res.text() };
    };
    return { get: (u) => req('GET', u), post: (u, f = {}) => req('POST', u, f) };
  };
  return ctx;
}

module.exports = { boot, idFrom: (loc) => Number(/\/events\/(\d+)/.exec(loc)?.[1]) };
