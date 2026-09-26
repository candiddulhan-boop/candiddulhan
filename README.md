# candiddulhan
Official website of Candid Dulhan

## RSVP & Guest Management

A white-label RSVP service for Candid Dulhan wedding clients. It lets you:

1. **Send invitations** to every guest on WhatsApp, each with their own RSVP link.
2. **Collect RSVPs and guest details** such as headcount, arrival and departure, stay, food preference and **government ID** (with consent).
3. **Share a live dashboard** with the client (couple or family) through one private link. It shows stats, the guest list, IDs, call recordings and a CSV download.
4. **Run your team like a CRM.** Each team member has their own login. You can assign guests to callers (or split them automatically), set follow-up reminders, keep a full activity timeline for every guest and track each person's performance.
5. **Run a calling team.** A mobile caller console gives tap-to-call, outcome logging and recording upload. An **Android recording upload API** lets recordings sync from the phone automatically.

### Business model: free software, paid RSVP desk

- **Event management companies sign up free** at `/signup`. Each company gets its own private workspace: its own weddings, guests, team and client dashboards. Companies can never see each other's data.
- Guests and couples see the **event company's name**, with a small "Powered by Candid Dulhan" line underneath.
- On any wedding, a company can click **"Let Candid Dulhan's RSVP desk call your guests"** and describe what they need.
- The request appears on **your Platform dashboard** (`/admin/platform`). When you **Accept**, your callers get access to that wedding only. When the company ends the service, your access is removed and your callers' guests are unassigned.
- The Platform dashboard also lists every partner company, their weddings, guest counts and last activity. It is your sales pipeline.
- Logging in with `ADMIN_PASSWORD` always signs you into the Candid Dulhan workspace.

### Guest management for wedding planners

- **Functions:** Haldi, Mehndi, Sangeet, Wedding, Reception (or any others), each with date, time, venue and dress code. Every guest is invited to some or all functions and **answers separately for each**. Headcounts per function update live on the planner and client dashboards.
- **Complete guest profile:** 44 built-in fields in 7 sections:
  - Contact: salutation, mobile, alternate phone, email, city, language
  - Relation: side, relation to couple, group, category (e.g. VIP), tags, party size, children
  - Arrival: date, time, mode, flight/train no., from, arriving at, pickup needed/status/vehicle
  - Departure: the same details, plus the drop
  - Stay: needs stay, hotel, room type, room no., check-in/out, sharing with
  - Care: food, allergies, special needs, welcome hamper
  - Notes: the guest's message and internal notes
- **Family members:** everyone travelling in a party, each with name, relation, age group, food and **their own ID**.
- **Custom fields per wedding:** text, number, date, dropdown or yes/no. Tick "Ask guests" to add the question to the RSVP page.
- **Rooming:** hotels with blocked room counts, and room assignment for each party. The rooming list downloads for the hotel.
- **Transport:** arrivals and departures by date and time, with a pickup or drop status and vehicle/driver for each party. Download a pickup sheet for the transport team.
- **Import:** a CSV with any of these fields (matched by name) and a `functions` column. **Export:** every field, each function's answer, family members and custom fields.
- **Dedicated staff:** when you accept a planner's RSVP desk request, you choose which 1–2 people from your team work on it. Only those people (and your admins) can see that wedding. The planner and the couple see their names ("Your guest managers: Neha, Ravi").

### Reports, AI and the mobile app

- **Reports & AI tab** on every wedding (`/admin/events/:id/insights`):
  - **Needs attention:** alerts that always work, no AI needed. Guests who haven't replied (with days until the first function), VIPs not confirmed, "maybe" guests, invites not sent, missing IDs (main guests and adult family members), pickups in the next 3 days with no vehicle, parties with no hotel room, hotels over their room block, missing arrival details, overdue follow-ups, open guests with no owner, and special-care counts.
  - **AI status report:** a headline, an executive summary, top risks, actions for the next 48 hours and ideas to delight guests, written from the live data. It is also included in the PDF.
  - **Ask anything:** questions in plain language, e.g. "How many Jain guests arrive on 10 Dec and need a pickup?"
  - **Downloads:**
    - **Excel workbook:** Summary, Guests (every field and each function's answer), Functions, Family members, Rooming, Arrivals, Departures, Food, Calls.
    - **Branded PDFs:** status report, guest list, rooming list, pickup sheet, drop sheet.
- **AI WhatsApp messages** on each guest: an RSVP reminder, invitation, ID request, travel request, personal itinerary or thank-you, in English, Hinglish or Hindi. There's a one-tap "Send on WhatsApp" button.
- **Smart fill for callers:** type rough notes in any language ("sangeet pe 3 log, 12 ko indigo 6E 234, jain, dadi ke liye wheelchair") and the AI fills in the RSVP for each function, travel, stay and food for the caller to check.
- **Client dashboard:** the couple can download a PDF report and an Excel file. These versions leave out internal notes and the team's to-do list.
- **Installable app (PWA):** open the site on Android (Chrome), iPhone (Safari: Share → Add to Home Screen) or a computer and tap **Install app**. It opens full-screen with its own icon, has shortcuts to "My follow-ups" and "Weddings", and shows an offline screen when there is no connection. Pages with guest data are never stored on the device.

**Switching on AI:** set `ANTHROPIC_API_KEY` in `.env`. The model is Claude Opus 5 (`claude-opus-5`); set `AI_MODEL` to use a different one. If Claude declines a request, Anthropic automatically retries it on its recommended fallback model (`fallbacks: "default"`). Guest **phone numbers and ID numbers are never sent to the AI**; names, RSVPs, travel and notes are. Mention this AI processing in your privacy notice. Without a key, everything else works and the AI buttons explain how to switch it on.

### Screens

| URL | Who | What |
|---|---|---|
| `/admin` | Candid Dulhan admins | Create weddings, import guests from CSV, send WhatsApp invites, assign guests, edit guests, export CSV |
| `/admin/team` | Admins | Add team members, set roles, reset passwords, deactivate; team performance |
| `/caller` | Calling team (phone) | My follow-ups due today, my guests, 📞 tap to call, log outcome, RSVP and next follow-up, attach recording, notes |
| `/i/<guest-token>` | Guest | Personal invitation and RSVP form (mobile first) |
| `/c/<client-token>` | Your client | Read-only dashboard with stats, guests, latest updates feed, IDs, calls and recordings, CSV. Optional PIN. |
| `/api/recordings` | Android phone | Upload call recordings (auto-matched to guests by phone number) |

### Try it (demo data included)

**Option 1: GitHub Codespaces (in your browser, nothing to install)**
1. On GitHub, open this repo and switch to the branch you want to test.
2. Click **Code → Codespaces → Create codespace on this branch**.
3. Wait about 2 minutes. It installs everything, loads a demo wedding and starts the app, and a browser tab opens. If it doesn't open, go to the **Ports** tab and click the globe icon next to port 3000.
4. Log in with one of the demo accounts below.

To open guest or client links on another phone, right-click port 3000 in the **Ports** tab and set **Port visibility → Public** (only while testing).

**Option 2: on your computer:** install [Node.js 22 LTS](https://nodejs.org), then:
```bash
git clone https://github.com/candiddulhan-boop/candiddulhan.git
cd candiddulhan && git checkout claude/wedding-rsvp-guest-management-1yg091
npm install
npm run seed        # demo wedding with 24 guests, 3 team members, calls and follow-ups
npm start           # open http://localhost:3000
```

**Demo logins** (password `demo123`):
- `meera@royalknot.demo`: a partner event company with one wedding using your RSVP desk and one wedding requesting it
- `priya@demo.in`: Candid Dulhan admin (Platform dashboard, accept requests)
- `neha@demo.in`, `ravi@demo.in`: Candid Dulhan callers working the partner wedding
Owner login: leave "Email or phone" empty and use `ADMIN_PASSWORD` (`admin` if it isn't set).

### Run it

Requires Node.js 22.13 or newer. There are no native dependencies, because the database is SQLite built into Node.

```bash
npm install
cp .env.example .env     # set ADMIN_PASSWORD, BASE_URL, API_KEY, SESSION_SECRET
npm start                # http://localhost:3000
```

Everything (database, IDs, recordings) is stored in `DATA_DIR` (default `./data`). **Back up this folder.**

To deploy, use any small VPS or a Node host that has a persistent disk, such as Railway, Render with a disk, a DigitalOcean droplet or AWS Lightsail. Put it behind HTTPS and set `BASE_URL` to the public URL, for example `https://rsvp.candiddulhan.com`.

### Team CRM

- **Accounts:** go to **Team → Add team member** and enter a name, login (email or phone), role and password. **Callers** only see the caller console; **admins** see everything. Deactivating someone signs them out immediately. The `ADMIN_PASSWORD` from `.env` always works as the owner login, and you can leave "Email or phone" empty when using it.
- **Assigning guests:** on a wedding page, tick guests, then choose **Assign to… → Assign selected**. **⚖ Auto-split unassigned** shares every unassigned guest who hasn't confirmed equally among callers. When a caller calls an unassigned guest, that guest becomes theirs.
- **Follow-ups:** when logging a call, set **Follow up on** (or tap *In 2 hours*, *Tomorrow 11 am* or *In 2 days*). Each caller's home screen lists **Follow-ups due today**, and overdue ones are shown in red. Logging a new call clears the old follow-up.
- **Timeline:** every guest has a history of added or imported, invite sent, RSVP received or changed (by the guest or the team), ID uploaded, calls, recordings synced from the phone, assignments, follow-ups and notes, with who did each and when.
- **Performance:** the team table (on each wedding and on the Weddings home) shows per person: guests assigned, still open, confirmed, calls, connected %, calls today and overdue follow-ups.
- **Client view:** the client sees the guest list, a **Latest updates** feed (RSVPs, IDs and invites only, never internal notes or assignments) and calls. You can set an optional **client PIN** in wedding settings.

### Workflow for a new client

1. **Admin → New wedding.** Enter the couple, date and venue, choose whether to collect IDs and travel details, and write the WhatsApp message template (`{name} {title} {date} {venue} {link}`).
2. **Import guests** from a CSV with the columns `name, phone, side, group, max_pax, email`. The client can fill a Google Sheet and export it as CSV.
3. **Send invites.** The green **WhatsApp** button opens WhatsApp with the message pre-filled for that guest and marks the guest as invited. Use **Link** to copy the RSVP link for SMS or email.
4. **Share the client dashboard link** from the top of the wedding page. You can rotate the link in Settings.
5. **Assign and follow up by phone.** Auto-split the guests who haven't replied among your callers. Each caller works through **My guests** and **Follow-ups due today**: they tap 📞 Call, and when they come back to the browser the log form opens so they can save the outcome, RSVP and next follow-up.
6. **Export CSV** for the hotel rooming list and transport planning.

### Call recordings from Android

Android doesn't let ordinary apps record calls, but most phones' **built-in dialer records calls to a folder**. Examples are Samsung (`Recordings/Call`), Xiaomi/Redmi (`MIUI/sound_recorder/call_rec`), OnePlus/Oppo/Realme (`Music/Recordings/Call Recordings`) and Google Phone (in supported regions). Turn on "auto-record calls" in the dialer settings, then choose one of these options:

**Option A: manual (no setup).** In the caller console's **Log** form, attach the recording file from the phone.

**Option B: automatic upload.** Use an automation app that watches the recordings folder and POSTs each new file:

```
POST {BASE_URL}/api/recordings
Header:  X-API-Key: <API_KEY>
Body (multipart/form-data):
  file       the audio file                          (required)
  phone      other party's number                    (optional; also read from the filename)
  direction  incoming | outgoing                     (optional)
  duration   seconds                                  (optional)
  called_at  ISO time, e.g. 2026-12-01T14:30:00+05:30 (optional)
  caller     team member name                          (optional)
```

- **Tasker:** Profile *File Modified* on the recordings folder → Task *HTTP Request* (Method POST, File to send `%evtprm1`, header `X-API-Key:…`).
- **Automate (LlamaLab):** flow *File monitor* → *HTTP request* (multipart, file field `file`).
- **HTTP Shortcuts / MacroDroid** work the same way.

The server works out the phone number from typical recording filenames (for example `Call recording +91 98765 43210_261201.m4a`) and attaches the recording to that guest. If a caller already logged the same call from the console within the last 30 minutes, the recording is added to that entry instead of creating a duplicate. Recordings that don't match a guest go to **Admin → Unmatched recordings**.

`GET /api/lookup?phone=…` (same API key) returns the guest's name, wedding and RSVP status. You can use it for a caller-ID pop-up in an automation.

> **Consent:** in India you should tell guests that calls may be recorded, for example "This call is recorded for RSVP coordination". Add this line to your calling script.

### Guest ID data: handle with care

Government IDs are sensitive personal data under India's DPDP Act 2023. The app:

- asks for explicit consent before accepting an ID upload, and records the consent time;
- stores ID files outside the public folder and serves them only to logged-in admins or through the client's private dashboard link, with `no-store` caching;
- shows masked ID numbers on the dashboard (`••••••••9012`); full numbers appear only in the admin view and CSV exports;
- lets an admin delete a single guest's ID data, and deleting a wedding removes all of its IDs and recordings.

**Good practice:** serve over HTTPS only, use strong passwords and API keys, restrict server access, and **delete the wedding (or its ID data) after the event.**

### Project layout

```
src/server.js        app setup, login
src/db.js            SQLite schema (events, guests, calls, users, activities) + migrations
src/tenancy.js       who can see which company's weddings
src/routes/admin.js  agency admin, team, assignment, RSVP-desk service, platform dashboard
src/routes/smart.js  Reports & AI tab, Excel/PDF downloads, AI endpoints
src/ai.js            Claude API client (model, fallbacks, errors)
src/smart.js         rule-based alerts + AI summary, Q&A, WhatsApp drafts, call-note smart fill
src/reports.js       Excel workbook (exceljs) and branded PDFs (pdfkit)
public/sw.js         service worker for the installable app
test/app.test.js     end-to-end tests (npm test), including data isolation between companies
src/routes/rsvp.js   guest invitation / RSVP form
src/routes/client.js client dashboard
src/routes/caller.js caller console
src/routes/api.js    Android recording upload + lookup API
src/shared.js        stats, tables, uploads, WhatsApp links
public/              CSS + small JS
```
