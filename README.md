# candiddulhan
Official website of Candid Dulhan

## RSVP & Guest Management

A white-label RSVP service for Candid Dulhan wedding clients. It lets you:

1. **Send invitations** to every guest on WhatsApp, each with their own RSVP link.
2. **Collect RSVPs and guest details** such as headcount, arrival and departure, stay, food preference and **government ID** (with consent).
3. **Share a live dashboard** with the client (couple or family) through one private link. It shows stats, the guest list, IDs, call recordings and a CSV download.
4. **Run your team like a CRM.** Each team member has their own login. You can assign guests to callers (or split them automatically), set follow-up reminders, keep a full activity timeline for every guest and track each person's performance.
5. **Run a calling team.** A mobile caller console gives tap-to-call, outcome logging and recording upload. An **Android recording upload API** lets recordings sync from the phone automatically.

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

**Demo logins** (password `demo123`): `priya@demo.in` (admin), `neha@demo.in` and `ravi@demo.in` (callers).
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
src/routes/admin.js  agency admin, team, assignment
src/routes/rsvp.js   guest invitation / RSVP form
src/routes/client.js client dashboard
src/routes/caller.js caller console
src/routes/api.js    Android recording upload + lookup API
src/shared.js        stats, tables, uploads, WhatsApp links
public/              CSS + small JS
```
