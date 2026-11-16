# Penguin HQ

A colorful, installable (PWA) home screen for RK's Penguin Air & Plumbing work bots (work only, no personal bots). Same setup as the Video Library: plain static files, no build step, hosted on GitHub Pages.

Live: https://rkem1800-sketch.github.io/penguin-hq/

## Add to Home Screen (iPhone)

Open the link in Safari → Share → **Add to Home Screen**. The icon is a penguin with a headset labeled **HQ**.

## Tabs

- **Home**: daily brief, **Needs you** (For Review tasks + anything flagged `needsRK`), workspace counts, the **Activity** feed (grouped by day), and app tiles.
- **Board** (PIN): Kanban with To Do, In Progress, For Review, Done, Future. On a phone you pick a column with the colored tabs and move cards with the ◀ / ▶ buttons; on a wide screen all five columns show. Cards have title, owner bot, priority (High/Med/Low), due date, notes and a "Needs me" flag. Search plus filters by bot and priority. Done cards drop off after 14 days. Old ticked tasks became Done; old open ones became To Do.
- **Work** (PIN): AR Collections, Job Closeout, Membership Tracker, Permits. Each opens a phone-friendly card list with status tabs, search, ＋ Add and tap-to-edit.
- **Bots**: every work bot grouped by area, with search and area chips, scheduled jobs, open-task count, and **Open chat**.

## What's public vs PIN-protected

This page is **public**. `hq.json` holds only bot names, one-line roles, job names/schedules, and app links.
The **board, workspaces, activity feed and daily brief** live in the Cloudflare Worker's KV and need RK's PIN, the **same PIN as the Video Library**. Because both apps share the origin `rkem1800-sketch.github.io`, a PIN saved in the Video Library in the same browser signs HQ in too, and signing out signs out both.

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

Same Worker as the Video Library: `https://video-library-api.rkem1800.workers.dev` (source: `rkem1800-sketch/video-library` → `worker/worker.js`). CORS allows only `https://rkem1800-sketch.github.io`. Wrong PINs share the Video Library lockout (10 per IP or 50 total → 15-minute lock, HTTP 429).

| Endpoint | Auth | What |
|---|---|---|
| `GET /hq/state` | `X-PIN` | Board: `{state: {tasks, deleted, updatedAt}}` |
| `PUT /hq/state` | `X-PIN` | Body `{tasks, deleted}`. Merged per task (newest `updatedAt` wins), deleted ids kept as tombstones. |
| `POST /hq/tasks` | write token | Bots upsert tasks: `{by, tasks: [partial task with id], deleted?: [ids], activity?: "text"}` |
| `GET /hq/ws` | `X-PIN` | Counts for all four workspaces |
| `GET /hq/ws/<name>` | `X-PIN` | `{state: {rows, deleted, updatedAt}, statuses}`; name = `ar`, `closeout`, `members`, `permits` |
| `PUT /hq/ws/<name>` | `X-PIN` | Body `{rows, deleted}`, merged like tasks |
| `POST /hq/ws/<name>` | write token | Bots upsert rows: `{by, rows: [partial row with id], deleted?: [ids], activity?: "text"}` |
| `GET /hq/activity` | `X-PIN` | `{events: [{id, ts, by, text, kind, ws?}]}`, newest first, max 200 |
| `POST /hq/activity` | write token | `{by, text, kind?, ws?}` or `{events: [...]}` (max 20 per call) |
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
