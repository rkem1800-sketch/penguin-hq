# Penguin HQ

A colorful, installable (PWA) home screen for RK's Penguin Air & Plumbing work bots (work only, no personal bots). Same setup as the Video Library: plain static files, no build step, hosted on GitHub Pages.

Live: https://rkem1800-sketch.github.io/penguin-hq/

## Add to Home Screen (iPhone)

Open the link in Safari → Share → **Add to Home Screen**. The icon is a penguin with a headset labeled **HQ**.

## Tabs

- **Home**: daily brief, **Needs you** (For Review tasks + anything flagged `needsRK`), workspace counts, the **Activity** feed (grouped by day), and app tiles.
- **Board** (PIN): Kanban with To Do, In Progress, For Review, Done, Future. On a phone you pick a column with the colored tabs and move cards with the ◀ / ▶ buttons; on a wide screen all five columns show. Cards have title, owner bot, priority (High/Med/Low), due date, notes and a "Needs me" flag. Search plus filters by bot and priority. Done cards drop off after 14 days. Old ticked tasks became Done; old open ones became To Do.
- **Work** (PIN): AR Collections, Job Closeout, Membership Tracker, Permits. Each opens a phone-friendly card list with status tabs, search, ＋ Add and tap-to-edit.
- **Plan** (PIN): Business Plan & Expenses — Business plan (`W - Ops CEO`), Budget vs actual (`Bud - Penguin Budget`), Expenses (`W - Quinn`, read-only QBO), and Fixed costs. All figures live only in Worker KV behind RK's PIN; empty sections show "Waiting for data from <bot>".
- **Bots**: every work bot grouped by area, with search and area chips, scheduled jobs, open-task count, and **Open chat**.

## What's public vs PIN-protected

This page is **public**. `hq.json` holds only bot names, one-line roles, job names/schedules, and app links.
The **board, workspaces, activity feed and daily brief** live in the Cloudflare Worker's KV and need RK's PIN, the **same PIN as the Video Library**. Because both apps share the origin `rkem1800-sketch.github.io`, a PIN saved in the Video Library in the same browser signs HQ in too, and signing out signs out both.


## Business Plan & Expenses (`/hq/finance`)

The **Plan** tab in HQ is a public shell with **no amounts, addresses, or financial figures** in this repo. All real figures live in `video-library-api` Worker KV (`hq:finance`), read behind RK's `X-PIN` (`GET /hq/finance`), and written by bots with `Authorization: Bearer $PENGUIN_HQ_WRITE_TOKEN` (`POST /hq/finance`).

Send `{ "section": "<name>", "by": "<bot>", "data": { ... } }` (each section updates independently; `data: null` clears a section). Never put real numbers or secrets in this README or repo.

- **`plan`** (`W - Ops CEO`): `{ "year": 2027, "note": "...", "yearly": [{ "label": "Yearly revenue goal", "amount": 0, "actual": 0, "sub": "...", "status": "on_track|behind|done" }], "quarters": [{ "label": "Q1", "amount": 0, "actual": 0, "sub": "...", "status": "on_track|behind|done" }] }`
- **`budget`** (`Bud - Penguin Budget`, ServiceTitan margins): `{ "period": "YYYY-MM", "note": "...", "revenue": { "actual": 0, "budget": 0, "sub": "..." }, "margins": [{ "label": "Replacements gross margin", "actual": 0, "target": 0, "status": "on_track|behind" }], "labor": { "actual": 0, "budget": 0 }, "overhead": { "actual": 0, "budget": 0 } }`
- **`expenses`** (`W - Quinn`, QuickBooks Online read-only): `{ "source": "QuickBooks Online (read-only)", "note": "...", "months": [{ "month": "YYYY-MM", "label": "...", "operatingTotal": 0, "otherTotal": 0, "total": 0, "categories": [{ "name": "...", "amount": 0 }] }] }`
- **`fixed`** (stored in KV only): `{ "note": "...", "items": [{ "id": "...", "title": "...", "landlord": "...", "address": "...", "monthlyTotal": 0, "breakdown": "...", "termEnd": "...", "renewedTo": "...", "escalation": "...", "reminderTitle": "...", "reminderText": "..." }] }`

(An earlier static example-only layout preview remains at `mockup-business.html` with invented placeholder figures only.)

## Files

| File | What |
|---|---|
| `index.html` | The whole app |
| `hq.json` | Areas, bots, scheduled jobs, links (public) |
| `sw.js` | Service worker. Bump `CACHE` (`penguin-hq-vN`) when content changes |
| `manifest.json`, `apple-touch-icon.png`, `icon-*.png`, `favicon.png` | PWA icon and metadata |

## hq.json format

```json
{
  "updated": "2026-11-15",
  "jobsNote": "Jobs are the last known from each bot's chat. They may have changed.",
  "areas": [{ "id": "money", "name": "Money", "emoji": "📊", "color": "#4ade80" }],
  "bots": [{
    "id": "10f95832-ee4b-4be2-88dc-fa8434bcf25d",
    "name": "Quinn – Bookkeeper",
    "area": "money",
    "emoji": "📗",
    "role": "One plain-English line.",
    "chat": "grokbot://app/v1/agent?id=10f95832-ee4b-4be2-88dc-fa8434bcf25d",
    "jobs": [{ "when": "Weekdays ~7 AM", "what": "QuickBooks check to #alerts", "status": "on" }]
  }],
  "links": [{ "name": "QuickBooks", "emoji": "📗", "url": "https://qbo.intuit.com", "color": "#22c55e" }]
}
```

`jobs[].status` is `"on"` or `"paused"`. Never put prompts, customer data, money, emails, phone numbers or keys here.

## Worker API (Penguin HQ endpoints)

Two Workers, same PIN (same salt + SHA-256 scheme), same write token:

- **Follow-ups** (`/hq/ws/followups`, `/hq/followups/run`, `/hq/followups/status`, plus a Follow-ups-only `/hq/activity` and `/hq/ws` count): Penguin-owned Worker **`https://penguin-hq-api.rkem1800.workers.dev`** (source: this repo → `worker/worker.js`, own KV namespace `penguin-hq-api`). The app merges its activity into the Home feed.
- **Everything else** (board, AR, closeout, members, permits, activity, brief): `https://video-library-api.rkem1800.workers.dev` (source: `rkem1800-sketch/video-library` → `worker/worker.js`).

penguin-hq-api has its own wrong-PIN lockout (same rules). CORS allows only `https://rkem1800-sketch.github.io`. Wrong PINs share the Video Library lockout (10 per IP or 50 total → 15-minute lock, HTTP 429).

| Endpoint | Auth | What |
|---|---|---|
| `GET /hq/state` | `X-PIN` | Board: `{state: {tasks, deleted, updatedAt}}` |
| `PUT /hq/state` | `X-PIN` | Body `{tasks, deleted}`. Merged per task (newest `updatedAt` wins), deleted ids kept as tombstones. |
| `POST /hq/tasks` | write token | Bots upsert tasks: `{by, tasks: [partial task with id], deleted?: [ids], activity?: "text"}` |
| `GET /hq/ws` | `X-PIN` | Counts for all five workspaces |
| `GET /hq/ws/<name>` | `X-PIN` | `{state: {rows, deleted, updatedAt}, statuses}`; name = `followups`, `ar`, `closeout`, `members`, `permits` |
| `PUT /hq/ws/<name>` | `X-PIN` | Body `{rows, deleted}`, merged like tasks |
| `POST /hq/ws/<name>` | write token | Bots upsert rows: `{by, rows: [partial row with id], deleted?: [ids], activity?: "text"}` |
| `POST /hq/followups/run` (penguin-hq-api) | `X-PIN` (start); write token (409 check only) | "Run update": if a sweep is already running (and started less than 30 minutes ago), returns **409** `{error:"running", running:true, startedAt}` and does **not** fire the webhook. Otherwise the Worker POSTs `{"source":"penguin-hq","action":"sweep","requestedAt":ISO}` to secret `FRONTDESK_SWEEP_WEBHOOK_URL` with `Authorization: Bearer <FRONTDESK_SWEEP_WEBHOOK_KEY>`, saves `running={startedAt, by}` in KV, and returns `{running:true, startedAt, lastRunRequested}`. Max once per 5 minutes (429 `too_soon`; a failed webhook call doesn't start the wait and clears `running`). 503 `not_configured` if the URL or key secret isn't set. A write-token POST never starts a sweep: 409 if one is running, otherwise 401. |
| `GET /hq/followups/status` (penguin-hq-api) | `X-PIN`, or write token, or Front Desk read token | `{connected, lastRunRequested, lastSweepFinished: {at, by, summary}, running, startedAt}`. `running` is true only when a sweep started less than 30 minutes ago; a stale flag is ignored. |
| `POST /hq/followups/status` (penguin-hq-api) | write token | Start (scheduled sweeps): `{"by":"Front Desk","startedAt":ISO,"running":true}` sets the running flag and `lastRunRequested` (does not change `lastSweepFinished`). Finish: `{"by":"Front Desk","finishedAt":ISO,"summary":"..."}` clears `running`, stores `lastSweepFinished`, and writes an activity event. Skipped: `{"by":"Front Desk","status":"skipped"}` clears `running` only. |
| `GET /hq/activity` | `X-PIN` | `{events: [{id, ts, by, text, kind, ws?}]}`, newest first, max 200 |
| `POST /hq/activity` | write token | `{by, text, kind?, ws?}` or `{events: [...]}` (max 20 per call) |
| `GET /hq/finance` | `X-PIN` | `{ok, finance: {plan, budget, expenses, fixed, updatedAt}}` |
| `POST /hq/finance` | write token | Bots post a section: `{section: "plan\|budget\|expenses\|fixed", by, data, activity?}` (or top-level section keys) |
| `GET /hq/brief` | `X-PIN` | `{brief}` |
| `PUT /hq/brief` | brief or write token | See below |

Every app change (task added, moved, edited, deleted; row added or updated) writes an activity event automatically (up to 5 per save plus a summary). Bot upserts write one summary event, or your `activity` text.

**Tokens** (write-only, can't read anything): `PENGUIN_HQ_WRITE_TOKEN` (all bot writes) and `PENGUIN_HQ_BRIEF_TOKEN` (brief only). Both live only in `~/.penguin-hq.env` on the Grok Bot box (mode 600, loaded by `~/.bashrc`). The Worker stores only their SHA-256 hashes (`HQ_WRITE_TOKEN_HASH`, `HQ_BRIEF_TOKEN_HASH`). To rotate: write a new token in the env file and upload its SHA-256 hex as the matching Worker secret.

### Task object

```json
{ "id": "t-abc123", "text": "Call the supply house", "bot": "<agent id or empty>",
  "status": "todo|doing|review|done|future", "priority": "high|med|low|", "due": "2026-11-20",
  "notes": "...", "needsRK": false, "createdAt": 0, "updatedAt": 0, "doneAt": 0 }
```

### Workspace rows

Every row has `id` (letters, digits, `-_.`, max 64), `status`, `needsRK`, `createdAt`, `updatedAt`. Dates are `YYYY-MM-DD`.

| Workspace | Statuses | Fields |
|---|---|---|
| `followups` | Waiting, Urgent, Contacted, Booked, Handled, Do not contact | `customer, phone, email, channel, contactedAt ("YYYY-MM-DD HH:MM" ET), want, urgency (urgent/normal), called, booked, chatted (each "yes", "no" or "" = not checked yet), job (ST job #), note, source, sourceId, lastSeen (date)` |
| `ar` | Not due, Due, In collection, Paid, Forgiven, Do not contact | `customer, invoice, balance (number), due, lastContact, note, source, sourceId` (days overdue is computed in the app) |
| `closeout` | Unresolved, Incomplete, Closed out | `job, customer, tech, date, flags (any of: permit, return visit, parts, estimate, rebate, photos), note` |
| `members` | Active not due, Confirmed due, Scheduled, Completed, Expired | `customer, plan, lastVisit, nextDue, note` |
| `permits` | Not started, In progress, Submitted, Approved, Closed | `job, customer, address, due, owner, comments` |

Bot upserts are patches: send `id` plus only the fields that changed. Unknown statuses fall back to the first status.

```bash
set -a; . ~/.penguin-hq.env; set +a
curl -s -X POST https://video-library-api.rkem1800.workers.dev/hq/ws/ar \
  -H "Authorization: Bearer $PENGUIN_HQ_WRITE_TOKEN" -H "Content-Type: application/json" \
  -d '{"by":"Quinn","rows":[{"id":"qbo-123","status":"In collection","lastContact":"2026-11-16","needsRK":true}],"activity":"Quinn: sent 3 reminders"}'

curl -s -X POST https://video-library-api.rkem1800.workers.dev/hq/activity \
  -H "Authorization: Bearer $PENGUIN_HQ_WRITE_TOKEN" -H "Content-Type: application/json" \
  -d '{"by":"Quinn","text":"sent 3 reminders","ws":"ar"}'
```

### Follow-ups (Front Desk bot)

Row ids: `fu-<slug>` or `fu-<channel>-<sourceId>` (e.g. `fu-st-chat-12345`). Channel is one of: ST Chat, ST Lead, ST Booking, Missed call, Signpost, Google LSA, Voicemail, Web form, Email. Open = Waiting, Urgent or Contacted (Booked, Handled and Do not contact are closed). Follow-ups rows go to **penguin-hq-api**, not video-library-api. When `booked` turns yes on an open row (Waiting/Urgent/Contacted), the Worker moves it to **Booked** (handled) automatically. `called`/`booked`/`chatted` are three-state strings: true/1/"Yes" → "yes", false/0 → "no", anything else → "" (not checked yet). On the card each is a big chip (✅ yes, ❌ no, ⬜ blank); a tap cycles blank → yes → no → blank and saves. The app sorts urgent first (urgency `urgent` or status Urgent), then oldest `contactedAt`. RK's big Done box sets status Handled. Home → Needs you shows the open count and lists the urgent ones.

A bot upsert never undoes RK: if a row is already Booked, Handled or Do not contact, the posted status is ignored unless the row has `"reopen": true`.

```bash
curl -s -X POST https://penguin-hq-api.rkem1800.workers.dev/hq/ws/followups \
  -H "Authorization: Bearer $PENGUIN_HQ_WRITE_TOKEN" -H "Content-Type: application/json" \
  -d '{"by":"Front Desk","rows":[{"id":"fu-st-chat-12345","customer":"Sample Customer","phone":"555-0100","channel":"ST Chat","contactedAt":"2026-11-16 07:12","want":"No heat upstairs","urgency":"urgent","called":"yes","booked":"no","chatted":"","status":"Waiting","source":"ServiceTitan","sourceId":"12345","lastSeen":"2026-11-16","needsRK":false}],"activity":"Front Desk: sweep found 1 new contact"}'

# when a scheduled sweep (7 AM / noon / 4 PM ET) starts — also clears the Run update button
curl -s -X POST https://penguin-hq-api.rkem1800.workers.dev/hq/followups/status \
  -H "Authorization: Bearer $PENGUIN_HQ_WRITE_TOKEN" -H "Content-Type: application/json" \
  -d '{"by":"Front Desk","startedAt":"2026-11-16T17:00:00.000Z","running":true}'

# when a sweep finishes (clears the running flag)
curl -s -X POST https://penguin-hq-api.rkem1800.workers.dev/hq/followups/status \
  -H "Authorization: Bearer $PENGUIN_HQ_WRITE_TOKEN" -H "Content-Type: application/json" \
  -d '{"by":"Front Desk","finishedAt":"2026-11-16T17:20:00.000Z","summary":"Checked 9 channels, 2 new, 1 urgent"}'

# if a scheduled sweep exits without running (clears running, leaves last summary alone)
curl -s -X POST https://penguin-hq-api.rkem1800.workers.dev/hq/followups/status \
  -H "Authorization: Bearer $PENGUIN_HQ_WRITE_TOKEN" -H "Content-Type: application/json" \
  -d '{"by":"Front Desk","status":"skipped"}'
```

### Follow-ups action buttons and Front Desk requests (penguin-hq-api)

Each Follow-ups card has big buttons: **📞 Call** (`tel:`) and **💬 Text** (`sms:`) are plain links on RK's phone and send nothing to any bot. **✍️ Draft a reply**, **📅 Schedule**, **🔎 Check their file** and **💬 Ask bot…** open a small box for an optional note (required for Ask) and send a request to the Front Desk bot. **🚫 Dismiss** (open cards only) asks `Dismiss this call in HQ and ServiceTitan?` and, if confirmed, queues `kind: dismiss` the same way — no note box. The card immediately shows **Dismissing…** until that request is `done` or `failed`. The Front Desk bot should then dismiss the call on the ServiceTitan dashboard and close the HQ row; it still never contacts the customer without RK's yes. **📝 Add note** appends a time-stamped line to the row's `note` and saves it with the normal PIN `PUT /hq/ws/followups`; it never goes to the bot. The card shows the row's latest request: status, RK's note and the bot's `result` text. While a request is queued or working, the app re-checks every 20 seconds.

| Endpoint | Auth | Body / query | Response |
|---|---|---|---|
| `POST /hq/followups/request` | `X-PIN` | `{"rowId":"fu-…","kind":"reply\|schedule\|check\|ask\|dismiss","note":"optional (required for ask), max 1000"}` | `200 {ok:true, webhookStatus, request}`; `502 {ok:false, error:"webhook_failed", webhookStatus, request, message}` (saved, still queued); `400 bad_kind / note_required`; `404 no_row`; `429 too_many` (20 per rolling hour, `retryAfter` s); `503 not_configured` |
| `GET /hq/ws/followups` | `Authorization: Bearer $PENGUIN_HQ_FRONTDESK_READ_TOKEN` (read-only, Front Desk) | — | Same as the PIN GET: `{ok, state:{rows, deleted, updatedAt}, statuses}`. Bots must GET first and reuse an existing id when phone, email or name matches. |
| `GET /hq/followups/requests?status=queued` | `Authorization: Bearer $PENGUIN_HQ_FRONTDESK_READ_TOKEN` (Front Desk) or `X-PIN` (app) | `status` = comma list of `queued,working,needs_rk,done,failed` or `all` (default); optional `id=rq-…` | `{ok:true, requests:[{id, rowId, kind, kindLabel, note, status, result, createdAt, updatedAt, row:{…full follow-up row…} or null}]}` |
| `POST /hq/followups/requests` | write token | `{"id":"rq-…","status":"working\|needs_rk\|done\|failed","result":"text for the card, max 2000","by":"Front Desk"}` or `{"deleted":["rq-…"]}` | `{ok:true, request}` / `{ok:true, removed}`; `400 bad_status`; `404 no_request` |

Request object: `{"id":"rq-…","rowId":"fu-…","kind":"check","note":"did we quote a heat pump?","status":"queued","result":"","createdAt":ms,"updatedAt":ms}`. Stored in KV `hq:fu:requests` (newest 300). Deleting a row deletes its requests.

**Lifecycle:** RK taps a button → `POST /hq/followups/request` stores it as `queued` and adds an activity event → the Worker POSTs `{"source":"penguin-hq","action":"request","requestId":"rq-…"}` (ids only, never customer data) to the Front Desk routine webhook → the bot `GET`s `/hq/followups/requests?id=rq-…` (or `?status=queued`) with the read token, gets the row joined in → posts `working` → does the work (never contacts the customer without RK's yes) → posts `needs_rk` (e.g. "Draft ready, approve in Front Desk chat"), `done` (e.g. a file-check answer) or `failed`, with `result`. Statuses other than `working` add an activity event. If the webhook call fails, the request stays `queued` and the bot should pick it up on its next sweep (`?status=queued`).

Run update (`/hq/followups/run`) and requests use the same webhook helper and secrets; payload `action` tells them apart (`sweep` or `request`).

```bash
set -a; . ~/.penguin-hq.env; set +a
curl -s "https://penguin-hq-api.rkem1800.workers.dev/hq/followups/requests?status=queued" -H "Authorization: Bearer $PENGUIN_HQ_FRONTDESK_READ_TOKEN"
curl -s -X POST https://penguin-hq-api.rkem1800.workers.dev/hq/followups/requests \
  -H "Authorization: Bearer $PENGUIN_HQ_WRITE_TOKEN" -H "Content-Type: application/json" \
  -d '{"by":"Front Desk","id":"rq-abc","status":"needs_rk","result":"Draft ready, approve in Front Desk chat"}'
```

`PENGUIN_HQ_FRONTDESK_READ_TOKEN` lives only in `~/.penguin-hq.env`; the Worker stores its SHA-256 as `HQ_FRONTDESK_READ_TOKEN_HASH`.

**Run update wiring:** Worker secrets on **penguin-hq-api**: `FRONTDESK_SWEEP_WEBHOOK_URL` (Front Desk "Follow-up sweep (Run now)" routine webhook) and `FRONTDESK_SWEEP_WEBHOOK_KEY` (sent as `Authorization: Bearer <key>`). Other secrets: `HQ_FRONTDESK_READ_TOKEN_HASH`, `PIN_SALT`, `PIN_HASH` (copied from the Video Library config, so the same PIN works), `HQ_WRITE_TOKEN_HASH`. Never put values in this repo. Deploys use `keep_bindings: ["secret_text"]`, so secrets survive redeploys. Deploy helper: `/workspace/penguin-hq-api/build.mjs` on the Grok Bot box (Cloudflare MCP).

### Daily brief

```
PUT https://video-library-api.rkem1800.workers.dev/hq/brief
Authorization: Bearer $PENGUIN_HQ_BRIEF_TOKEN
Content-Type: application/json
```

```json
{
  "date": "Mon Nov 16",
  "title": "Daily brief",
  "headline": "3 things today",
  "items": [
    { "emoji": "📗", "text": "Approve 5 bills Quinn queued up", "bot": "10f95832-ee4b-4be2-88dc-fa8434bcf25d" },
    { "emoji": "📞", "text": "Call back 2 missed callers" }
  ],
  "from": "Grok Bot"
}
```

Limits: `date` 20 chars, `title` 80, `headline` 300, up to 12 `items` (`text` 300, `emoji` 8, `bot` = agent id, optional; shows an **Open** button to that bot's chat), `from` 60. Needs a `headline` or at least one item. The Worker stamps `updatedAt`. Each PUT replaces the previous brief. Responses: `200 {ok, brief}`, `400 bad_brief`, `401 bad_token`. Posting a brief also adds a ☀️ activity event.

The brief accepts either `PENGUIN_HQ_BRIEF_TOKEN` or `PENGUIN_HQ_WRITE_TOKEN`.

Example from the box:

```bash
set -a; . ~/.penguin-hq.env; set +a
curl -s -X PUT https://video-library-api.rkem1800.workers.dev/hq/brief \
  -H "Authorization: Bearer $PENGUIN_HQ_BRIEF_TOKEN" -H "Content-Type: application/json" \
  --data @brief.json
```

## Run locally

```bash
python3 -m http.server 8080
```

(Sign-in only works on the live site, because the Worker's CORS allows only the GitHub Pages origin.)

## Sync

Board and workspaces are cached in `localStorage` (`hq.tasks.v1`, `hq.ws.<name>.v1`) and sync about a second after each change, when the app opens, and when it comes back to the foreground. Changes made offline sync later.
