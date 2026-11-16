# Penguin HQ

A colorful, installable (PWA) home screen for RK's Penguin Air & Plumbing work bots (work only, no personal bots). Same setup as the Video Library: plain static files, no build step, hosted on GitHub Pages.

Live: https://rkem1800-sketch.github.io/penguin-hq/

## Add to Home Screen (iPhone)

Open the link in Safari → Share → **Add to Home Screen**. The icon is a penguin with a headset labeled **HQ**.

## Tabs

- **Home**: the daily brief (PIN), quick counts, and colorful tiles for apps and tools.
- **Bots**: every bot grouped by area, with search and area chips. Each card has a role, any known scheduled jobs, and **Open chat** (`grokbot://app/v1/agent?id=<id>`).
- **Tasks** (PIN): one task list across all bots. Add, tick, delete (tap 🗑 twice), and tag a bot.

## What's public vs PIN-protected

This page is **public**. `hq.json` holds only bot names, one-line roles, job names/schedules, and app links.
**Tasks** and the **daily brief** live in the Cloudflare Worker's KV and need RK's PIN, the **same PIN as the Video Library**. Because both apps share the origin `rkem1800-sketch.github.io`, a PIN saved in the Video Library in the same browser signs HQ in too, and signing out signs out both.

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
| `GET /hq/state` | `X-PIN` | `{ok, state: {tasks: [...], deleted: [ids], updatedAt}}` |
| `PUT /hq/state` | `X-PIN` | Body `{tasks: [...], deleted: [ids]}`. Server merges per task (newest `updatedAt` wins) and keeps deleted ids as tombstones, so two phones don't overwrite each other. |
| `GET /hq/brief` | `X-PIN` | `{ok, brief: {...} \| null}` |
| `PUT /hq/brief` (or `POST`) | `Authorization: Bearer <brief token>` | Writes the daily brief. Write-only: the token can't read anything. |

Task object:

```json
{ "id": "t-abc123", "text": "Call the Lennox rep", "bot": "<agent id or empty>", "done": false,
  "createdAt": 1763250000000, "updatedAt": 1763250000000, "doneAt": 0 }
```

Tasks are cached in `localStorage` (`hq.tasks.v1`, `hq.deleted.v1`) and sync about a second after each change, when the app opens, and when it comes back to the foreground.

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

Limits: `date` 20 chars, `title` 80, `headline` 300, up to 12 `items` (`text` 300, `emoji` 8, `bot` = agent id, optional; shows an **Open** button to that bot's chat), `from` 60. Needs a `headline` or at least one item. The Worker stamps `updatedAt`. Each PUT replaces the previous brief. Responses: `200 {ok, brief}`, `400 bad_brief`, `401 bad_token`.

**Brief token:** the Worker stores only the SHA-256 hash of the token (`HQ_BRIEF_TOKEN_HASH` secret). The token itself lives only on the Grok Bot box in `~/.penguin-hq.env` as `PENGUIN_HQ_BRIEF_TOKEN` (mode 600, loaded by `~/.bashrc`). To rotate: write a new token there, then upload its SHA-256 hex as the Worker secret `HQ_BRIEF_TOKEN_HASH`.

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
