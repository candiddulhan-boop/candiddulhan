const { chromium } = require('playwright');
// Records two captioned demo videos (desktop planner tour + mobile guest/caller) against a running demo server.
// Usage: DATA_DIR=./demo-data npm run seed
//        DATA_DIR=./demo-data ANTHROPIC_API_KEY=show-ai-buttons PORT=3999 npm start   (in another terminal)
//        DATA_DIR=./demo-data node scripts/record-demo.js        → videos in ./demo-videos/
// Requires Playwright (npm i -D playwright). Nothing calls the AI; the key only makes AI buttons visible.
const path = require('node:path');
const S = process.env.OUT || path.join(__dirname, '..', 'demo-videos'), B = process.env.BASE || 'http://localhost:3999';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Visible cursor + caption bar, injected into every page.
const INIT = () => {
  window.addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.id = '__cursor';
    c.style.cssText = 'position:fixed;z-index:99999;width:18px;height:18px;border-radius:50%;background:rgba(140,28,58,.55);border:2px solid #fff;box-shadow:0 0 0 2px rgba(140,28,58,.4);pointer-events:none;transform:translate(-50%,-50%);left:-40px;top:-40px;transition:left .08s,top .08s';
    document.body.appendChild(c);
    document.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    document.addEventListener('mousedown', () => { c.style.transform = 'translate(-50%,-50%) scale(.7)'; }, true);
    document.addEventListener('mouseup', () => { c.style.transform = 'translate(-50%,-50%)'; }, true);
  });
};
async function caption(page, title, sub = '') {
  await page.evaluate(([t, s]) => {
    let el = document.getElementById('__cap');
    if (!el) {
      el = document.createElement('div');
      el.id = '__cap';
      el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99998;width:max-content;max-width:min(92vw,880px);box-sizing:border-box;background:rgba(43,29,26,.92);color:#fff;padding:12px 20px;border-radius:12px;font:15px/1.4 Inter,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);text-align:center';
      document.body.appendChild(el);
    }
    el.innerHTML = `<div style="font-weight:700;font-size:1.05em">${t}</div>${s ? `<div style="opacity:.85;font-size:.9em;margin-top:2px">${s}</div>` : ''}`;
  }, [title, sub]);
}
async function scroll(page, px, ms = 1600) {
  const steps = 20;
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, px / steps); await sleep(ms / steps); }
}
async function moveTo(page, locator) {
  const box = await locator.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 });
  await sleep(250);
}
async function click(page, locator) { await locator.scrollIntoViewIfNeeded(); await moveTo(page, locator); await locator.click(); }
async function type(locator, text) { await locator.click(); await locator.pressSequentially(text, { delay: 35 }); }

async function login(page, user, pass = 'demo123') {
  await page.goto(B + '/login');
  await type(page.locator('input[name=login]'), user);
  await type(page.locator('input[name=password]'), pass);
  await click(page, page.locator('button.primary'));
  await page.waitForLoadState();
}

(async () => {
  const browser = await chromium.launch();

  // ================= Desktop: planner + platform =================
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: `${S}/video/desktop`, size: { width: 1280, height: 800 } } });
  await dctx.addInitScript(INIT);
  const p = await dctx.newPage();

  await p.goto(B + '/signup');
  await caption(p, 'Candid Dulhan RSVP — guest management for wedding planners', 'Event companies create a free account in 30 seconds');
  await sleep(3500);

  await login(p, 'meera@royalknot.demo');
  await caption(p, 'Planner home: every wedding at a glance', 'Branded with the planner’s company name · RSVP desk status per wedding');
  await sleep(3500);

  await click(p, p.locator('a.event-card', { hasText: 'Aarav & Diya' }));
  await caption(p, 'Live wedding dashboard', 'Your dedicated Candid Dulhan guest managers · smart alerts · live counts');
  await sleep(3500);
  await scroll(p, 520);
  await caption(p, 'Headcount for every function', 'Haldi, Mehndi, Sangeet, Wedding, Reception — updates as guests reply');
  await sleep(3200);
  await scroll(p, 700);
  await caption(p, 'Team performance & activity feed', 'Who called whom, confirmations, overdue follow-ups');
  await sleep(3000);
  await scroll(p, 900);
  await caption(p, 'Guest list with per-function RSVP, owner, calls & WhatsApp invites', 'Bulk assign · auto-split among callers · invite to functions');
  await sleep(3500);

  await click(p, p.locator('table.guests a', { hasText: 'Rajesh Sharma' }).first());
  await caption(p, 'Complete guest profile', 'RSVP per function · 44 fields: contact, travel, pickup, hotel, food, special needs');
  await sleep(3000);
  await scroll(p, 900, 2400);
  await caption(p, 'Arrival, departure, stay & care — all in one place');
  await sleep(2500);
  await scroll(p, 1100, 2400);
  await caption(p, 'Family members with individual IDs · timeline of every call & update');
  await sleep(3000);

  await p.goto(B + '/admin/events/' + (await p.evaluate(() => document.querySelector('a[href^="/admin/events/"]').getAttribute('href').split('/')[3])) + '/rooming');
  await caption(p, 'Rooming', 'Hotels with blocked rooms · assign rooms per family · download rooming list for the hotel');
  await sleep(3800);

  await click(p, p.locator('.subnav a', { hasText: 'Transport' }));
  await caption(p, 'Transport: arrivals & pickups by time', 'Flight/train, pax, hotel · assign vehicle & driver · rows in red still need a car');
  await sleep(3000);
  await scroll(p, 500);
  await sleep(1500);

  await click(p, p.locator('.subnav a', { hasText: 'Reports & AI' }));
  await caption(p, '✨ Reports & AI', 'Needs-attention alerts · AI status report (sample shown) · ask questions in plain English');
  await sleep(4200);
  await moveTo(p, p.locator('.ask textarea'));
  await caption(p, 'Ask anything about your guests', '“Which VIPs haven’t confirmed?” · “Jain headcount for the Sangeet?” (needs your AI key)');
  await sleep(3500);
  await moveTo(p, p.locator('.report-tile', { hasText: 'Complete workbook' }));
  await caption(p, 'One-click reports', 'Excel workbook (9 sheets) · branded PDF status report, guest list, rooming list, pickup & drop sheets');
  await sleep(3800);

  const clientUrl = await p.evaluate(async () => {
    const r = await fetch(location.pathname.replace('/insights', ''));
    const t = await r.text();
    return new DOMParser().parseFromString(t, 'text/html').querySelector('.share input').value;
  });
  await p.goto(clientUrl);
  await caption(p, 'What the couple & family see', 'A private dashboard: headcounts, guest list, latest RSVPs, rooming, arrivals, PDF/Excel downloads');
  await sleep(4000);
  await scroll(p, 700);
  await sleep(2000);

  await p.goto(B + '/login');
  await login(p, 'priya@demo.in');
  await p.goto(B + '/admin/platform');
  await caption(p, 'Your business view (Candid Dulhan)', 'Partner companies using the free software · weddings requesting your paid RSVP desk');
  await sleep(4000);
  const accept = p.locator('.accept-form').first();
  await click(p, accept.locator('input[type=checkbox]').first());
  await caption(p, 'Accept a request and assign your 1–2 guest managers');
  await sleep(1800);
  await click(p, accept.locator('button', { hasText: 'Accept' }));
  await caption(p, 'Done — your staff now work this wedding on the planner’s behalf', 'Only assigned staff can see it · the planner and couple see their names');
  await sleep(4500);

  await p.close();
  await dctx.close();

  // ================= Mobile: guest RSVP + caller =================
  const db = require('../src/db');
  const g = db.prepare("SELECT token FROM guests WHERE name = 'Sunil Bansal'").get();
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: false, deviceScaleFactor: 2,
    recordVideo: { dir: `${S}/video/mobile`, size: { width: 390, height: 844 } } });
  await mctx.addInitScript(INIT);
  const m = await mctx.newPage();
  await m.goto(`${B}/i/${g.token}`);
  await caption(m, 'The guest taps their WhatsApp link', 'A personal invitation — no app needed');
  await sleep(3500);
  const blocks = m.locator('.fn-block');
  const n = await blocks.count();
  await caption(m, 'Answer for each function');
  for (let i = 0; i < n; i++) {
    await click(m, blocks.nth(i).locator('.pill', { hasText: i === 0 ? 'Can’t make it' : 'Attending' }));
    await sleep(350);
  }
  await sleep(800);
  await caption(m, 'Who is coming, with ID for every adult');
  const slot = m.locator('.member-slot').first();
  await slot.scrollIntoViewIfNeeded();
  await type(slot.locator('input[name$="_name"]'), 'Anita Bansal');
  await type(slot.locator('input[name$="_relation"]'), 'Wife');
  await slot.locator('select[name$="_age"]').selectOption('Adult');
  await sleep(800);
  await caption(m, 'Arrival details for pickups');
  const ad = m.locator('input[name=arrival_date]');
  await ad.scrollIntoViewIfNeeded();
  await ad.fill('2026-12-10');
  await m.locator('input[name=arrival_time]').fill('10:45');
  await m.locator('select[name=arrival_mode]').selectOption('Flight');
  await type(m.locator('input[name=arrival_details]'), '6E 5023');
  await m.locator('select[name=pickup_required]').selectOption('1');
  await m.locator('select[name=needs_stay]').selectOption('1');
  await sleep(700);
  await caption(m, 'Food, special needs & ID — with consent');
  const diet = m.locator('select[name=dietary]');
  await diet.scrollIntoViewIfNeeded();
  await diet.selectOption('Jain');
  await type(m.locator('input[name=special_needs]'), 'Wheelchair for Maa ji');
  await m.locator('select[name=id_type]').selectOption('Aadhaar');
  await m.locator('input[name=id_file]').setInputFiles({ name: 'aadhaar.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
  await click(m, m.locator('input[name=id_consent]'));
  await sleep(700);
  await click(m, m.locator('button.primary.big'));
  await m.waitForLoadState();
  await caption(m, 'RSVP received ✓', 'The planner and the couple see it instantly');
  await sleep(4000);

  await login(m, 'ravi@demo.in');
  await caption(m, 'Caller app: my follow-ups for today', 'Overdue in red · tap to call · installs on the phone like an app');
  await sleep(3800);
  await click(m, m.locator('.call-list li').first().locator('a', { hasText: 'Log' }));
  await caption(m, 'After the call: log it in seconds');
  await sleep(2200);
  const fnSel = m.locator('select[name^="fn_rsvp_"]');
  const k = await fnSel.count();
  for (let i = 0; i < k; i++) await fnSel.nth(i).selectOption('yes');
  await caption(m, 'Update RSVP per function', '✨ or type rough notes and let AI Smart-fill the form (needs your AI key)');
  await sleep(1500);
  await type(m.locator('textarea[name=notes]'), 'Confirmed all functions, 4 people, will share flight tomorrow');
  await sleep(600);
  await click(m, m.locator('[data-in="tomorrow"]'));
  await caption(m, 'Set the next follow-up in one tap');
  await sleep(1800);
  await click(m, m.locator('button.primary.big'));
  await m.waitForLoadState();
  await caption(m, 'Saved — the planner’s dashboard updates live', 'Every call, note and RSVP change goes into the guest timeline');
  await sleep(4000);
  await m.close();
  await mctx.close();
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
