// Penguin HQ API — Cloudflare Worker (module syntax). Owns the HQ Follow-ups tracker.
// Everything else in HQ (board, other workspaces, brief, activity) still lives on video-library-api.
// Secrets (Worker secrets only, never in this repo):
//   PIN_SALT, PIN_HASH          same PIN as the Video Library: PIN_HASH = SHA-256 hex of PIN_SALT + ":" + PIN
//   HQ_WRITE_TOKEN_HASH         SHA-256 hex of PENGUIN_HQ_WRITE_TOKEN (bot writes)
//   HQ_FRONTDESK_READ_TOKEN_HASH  SHA-256 hex of PENGUIN_HQ_FRONTDESK_READ_TOKEN (Front Desk reads its request queue)
//   FRONTDESK_SWEEP_WEBHOOK_URL, FRONTDESK_SWEEP_WEBHOOK_KEY   Front Desk "Follow-up sweep (Run now)" routine webhook
const ORIGIN = "https://rkem1800-sketch.github.io";
const MAX_FAILS = 10, GLOBAL_MAX_FAILS = 50, LOCK_SECONDS = 900;
const RUN_EVERY_MS = 5 * 60000, RUN_STALE_MS = 30 * 60000;
const MAX_ROWS = 2000, MAX_TOMBS = 2000, MAX_EVENTS = 200;
const KEY_ROWS = "hq:ws:followups", KEY_SWEEP = "hq:fu:sweep", KEY_ACT = "hq:activity", KEY_REQ = "hq:fu:requests";
const REQ_PER_HOUR = 20, MAX_REQS = 300;
const REQ_KINDS = { reply: "Draft a reply", schedule: "Schedule", check: "Check their file", ask: "Ask bot", dismiss: "Dismiss" };
const REQ_STATUSES = ["queued", "working", "needs_rk", "done", "failed"];

function cors(req) {
  const h = { "Vary": "Origin" };
  if (req.headers.get("Origin") === ORIGIN) {
    h["Access-Control-Allow-Origin"] = ORIGIN;
    h["Access-Control-Allow-Methods"] = "GET, PUT, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, X-PIN, Authorization";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}
function json(req, status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(req) } });
}
async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); }
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function readJson(req) { try { const t = await req.text(); if (t.length > 100000) return null; return JSON.parse(t || "{}"); } catch (e) { return null; } }

// ---------- PIN (same scheme and lockout rules as the Video Library) ----------
async function lockState(env, ip) {
  const [mine, all] = await Promise.all([env.KV.get("fails:" + ip, "json"), env.KV.get("fails:all", "json")]);
  const now = Date.now();
  const lockedUntil = Math.max(mine && mine.lockedUntil || 0, all && all.lockedUntil || 0);
  return { mine: mine || { n: 0 }, all: all || { n: 0 }, locked: lockedUntil > now, retryAfter: Math.ceil((lockedUntil - now) / 1000) };
}
async function recordFail(env, ip, ls) {
  const now = Date.now();
  const mine = { n: (ls.mine.n || 0) + 1 }; if (mine.n >= MAX_FAILS) mine.lockedUntil = now + LOCK_SECONDS * 1000;
  const all = { n: (ls.all.n || 0) + 1 }; if (all.n >= GLOBAL_MAX_FAILS) all.lockedUntil = now + LOCK_SECONDS * 1000;
  await Promise.all([
    env.KV.put("fails:" + ip, JSON.stringify(mine), { expirationTtl: LOCK_SECONDS }),
    env.KV.put("fails:all", JSON.stringify(all), { expirationTtl: LOCK_SECONDS })
  ]);
  return { left: Math.max(0, MAX_FAILS - mine.n), locked: !!(mine.lockedUntil || all.lockedUntil) };
}
async function checkPin(req, env) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const ls = await lockState(env, ip);
  if (ls.locked) return json(req, 429, { ok: false, error: "locked", message: "Too many wrong PINs. Try again in 15 minutes.", retryAfter: ls.retryAfter });
  const pin = req.headers.get("X-PIN") || "";
  if (!pin) return json(req, 401, { ok: false, error: "pin_required", message: "Sign in with your PIN." });
  if (!env.PIN_SALT || !env.PIN_HASH) return json(req, 409, { ok: false, error: "not_setup", message: "Set up first." });
  const h = await sha256Hex(env.PIN_SALT + ":" + pin);
  if (!safeEq(h, String(env.PIN_HASH).toLowerCase())) {
    const r = await recordFail(env, ip, ls);
    return json(req, r.locked ? 429 : 401, { ok: false, error: r.locked ? "locked" : "bad_pin", message: r.locked ? "Too many wrong PINs. Try again in 15 minutes." : "Wrong PIN.", triesLeft: r.left });
  }
  if (ls.mine.n) await env.KV.delete("fails:" + ip);
  return null;
}
async function tokenOk(req, env, secretName) {
  const want = env[secretName || "HQ_WRITE_TOKEN_HASH"];
  const tok = (req.headers.get("Authorization") || "").replace(/^bearer\s+/i, "").trim();
  if (!tok || tok.length > 200 || !want) return false;
  return safeEq(await sha256Hex(tok), String(want).toLowerCase());
}

// ---------- Follow-ups rows ----------
const STATUSES = ["Waiting", "Urgent", "Contacted", "Booked", "Handled", "Do not contact"];
const OPEN = ["Waiting", "Urgent", "Contacted"];
const KEEP = ["Handled", "Do not contact", "Booked"]; // a bot upsert never undoes these unless reopen:true
const FIELDS = { customer: "s", phone: "s", email: "s", channel: "s", contactedAt: "dt", want: "l", urgency: "u", job: "s", note: "l", source: "s", sourceId: "s", lastSeen: "d", called: "yn", booked: "yn", chatted: "yn" };
function str(v, max) { return typeof v === "string" ? v.trim().slice(0, max) : (typeof v === "number" && isFinite(v) ? String(v).slice(0, max) : ""); }
function num(x) { return typeof x === "number" && isFinite(x) && x > 0 ? Math.floor(x) : 0; }
function goodId(id) { return !!id && id.length <= 64 && /^[\w.-]+$/.test(id); }
function yn(v) { const x = typeof v === "string" ? v.trim().toLowerCase() : v; return (x === true || x === 1 || x === "yes" || x === "true" || x === "1") ? "yes" : (x === false || x === 0 || x === "no" || x === "false" || x === "0") ? "no" : ""; }
function cleanRow(r) {
  if (!r || typeof r !== "object") return null;
  const id = str(r.id, 64); if (!goodId(id)) return null;
  const now = Date.now();
  const out = { id, status: STATUSES.includes(r.status) ? r.status : STATUSES[0], needsRK: r.needsRK === true, createdAt: num(r.createdAt) || now, updatedAt: num(r.updatedAt) || now };
  for (const [k, t] of Object.entries(FIELDS)) {
    if (t === "s") out[k] = str(r[k], 200);
    else if (t === "l") out[k] = str(r[k], 2000);
    else if (t === "d") { const v = str(r[k], 10); out[k] = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ""; }
    else if (t === "dt") { const v = str(r[k], 16); out[k] = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(v) ? v : ""; }
    else if (t === "yn") out[k] = yn(r[k]);
    else if (t === "u") out[k] = r[k] === "urgent" ? "urgent" : "normal";
  }
  return out;
}
// A job booked for them means the follow-up is handled: when booked turns "yes", an open row moves to Booked.
function autoBooked(item, old, raw) {
  if (item.booked === "yes" && (!old || old.booked !== "yes") && OPEN.includes(item.status) && !(raw && raw.reopen === true && OPEN.includes(raw.status))) item.status = "Booked";
  return item;
}
function title(r) { return r.customer || r.phone || r.email || "Contact"; }
function ev(by, text, kind) { return { id: "e" + Date.now().toString(36) + randHex(3), ts: Date.now(), by: str(by, 60) || "RK", text: str(text, 300), kind: kind || "note", ws: "followups" }; }
async function addEvents(env, evs) {
  if (!evs.length) return;
  const cur = (await env.KV.get(KEY_ACT, "json")) || { events: [] };
  await env.KV.put(KEY_ACT, JSON.stringify({ events: evs.concat(cur.events || []).slice(0, MAX_EVENTS), updatedAt: Date.now() }));
}
async function readRows(env) {
  const raw = (await env.KV.get(KEY_ROWS, "json")) || {};
  return { rows: (Array.isArray(raw.rows) ? raw.rows : []).map(cleanRow).filter(Boolean), deleted: Array.isArray(raw.deleted) ? raw.deleted : [], updatedAt: raw.updatedAt || 0 };
}
// mode "replace": newest updatedAt wins (app). mode "patch": fields merge onto the existing row (bots).
async function writeRows(env, body, mode, by) {
  const cur = await readRows(env);
  const tombs = new Set(cur.deleted.filter((x) => typeof x === "string"));
  const byId = new Map(cur.rows.map((x) => [x.id, x]));
  const evs = []; let added = 0, changed = 0, removed = 0;
  for (const id of (Array.isArray(body.deleted) ? body.deleted : [])) {
    if (typeof id !== "string" || id.length > 64) continue;
    if (byId.has(id)) { removed++; if (mode === "replace" && evs.length < 5) evs.push(ev(by, "Deleted from Follow-ups: " + title(byId.get(id)), "delete")); }
    tombs.add(id); byId.delete(id);
  }
  const incoming = Array.isArray(body.rows) ? body.rows : [];
  for (const raw of incoming.slice(0, MAX_ROWS)) {
    if (!raw || typeof raw !== "object") continue;
    const old = byId.get(str(raw.id, 64));
    let item;
    if (mode === "patch") {
      const keepSt = old && KEEP.includes(old.status) && raw.reopen !== true ? { status: old.status } : {};
      item = cleanRow(Object.assign({}, old || {}, raw, keepSt, { updatedAt: Date.now(), createdAt: old ? old.createdAt : Date.now() }));
    } else item = cleanRow(raw);
    if (!item || tombs.has(item.id) && mode !== "patch") continue;
    if (mode === "patch") tombs.delete(item.id);
    if (old && mode === "replace" && (item.updatedAt || 0) < (old.updatedAt || 0)) continue;
    autoBooked(item, old, raw);
    if (!old) { added++; if (mode === "replace" && evs.length < 5) evs.push(ev(by, "Added to Follow-ups: " + title(item), "add")); }
    else if (JSON.stringify(Object.assign({}, old, { updatedAt: 0 })) !== JSON.stringify(Object.assign({}, item, { updatedAt: 0 }))) {
      changed++;
      if (mode === "replace" && evs.length < 5) { const moved = old.status !== item.status; evs.push(ev(by, (moved ? "Moved to " + item.status + ": " : "Updated in Follow-ups: ") + title(item), moved ? "move" : "update")); }
    }
    byId.set(item.id, item);
  }
  const st = { rows: [...byId.values()].filter((x) => !tombs.has(x.id)).slice(-MAX_ROWS), deleted: [...tombs].slice(-MAX_TOMBS), updatedAt: Date.now() };
  await env.KV.put(KEY_ROWS, JSON.stringify(st));
  if (removed) { const rq = await readReqs(env); const left = rq.filter((q) => !tombs.has(q.rowId)); if (left.length !== rq.length) await writeReqs(env, left); }
  if (mode === "patch") {
    const custom = str(body.activity, 300);
    if (custom) evs.push(ev(by, custom, "bot"));
    else if (added || changed || removed) evs.push(ev(by, "Follow-ups: " + [added && added + " added", changed && changed + " updated", removed && removed + " removed"].filter(Boolean).join(", "), "bot"));
  } else if (evs.length >= 5 && added + changed + removed > 5) evs.push(ev(by, "Follow-ups: " + (added + changed + removed - 5) + " more changes", "update"));
  await addEvents(env, evs);
  return { st, added, changed, removed };
}

function activeRunning(meta) {
  const r = meta && meta.running;
  if (!r || !r.startedAt) return null;
  const t = Date.parse(r.startedAt);
  if (!isFinite(t) || Date.now() - t > RUN_STALE_MS) return null;
  return r;
}
function runningFields(meta) { const r = activeRunning(meta); return { running: !!r, startedAt: r ? r.startedAt : null }; }
function webhookKey(env) { return String(env.FRONTDESK_SWEEP_WEBHOOK_KEY || "").trim().replace(/^authorization:\s*/i, "").replace(/^bearer\s+/i, ""); }
function connected(env) { return !!(String(env.FRONTDESK_SWEEP_WEBHOOK_URL || "").trim() && webhookKey(env)); }
// One helper for every call to the Front Desk routine webhook. Payloads carry ids only, never customer data.
async function callFrontDesk(env, payload) {
  try {
    const resp = await fetch(String(env.FRONTDESK_SWEEP_WEBHOOK_URL).trim(), { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + webhookKey(env) }, body: JSON.stringify(Object.assign({ source: "penguin-hq" }, payload)) });
    return { ok: resp.ok, status: resp.status };
  } catch (e) { return { ok: false, status: 0 }; }
}

// ---------- Requests RK sends to the Front Desk bot ----------
async function readReqs(env) { const raw = (await env.KV.get(KEY_REQ, "json")) || {}; return Array.isArray(raw.requests) ? raw.requests : []; }
async function writeReqs(env, list) { await env.KV.put(KEY_REQ, JSON.stringify({ requests: list.slice(-MAX_REQS), updatedAt: Date.now() })); }
async function createRequest(req, env, body, by) {
  if (!connected(env)) return json(req, 503, { ok: false, error: "not_configured", message: "The Front Desk bot isn't connected yet." });
  const rowId = str(body && body.rowId, 64), kind = str(body && body.kind, 20), note = str(body && body.note, 1000);
  if (!REQ_KINDS[kind]) return json(req, 400, { ok: false, error: "bad_kind", message: "kind must be reply, schedule, check, ask or dismiss." });
  if (kind === "ask" && !note) return json(req, 400, { ok: false, error: "note_required", message: "Type your question for the bot." });
  const row = (await readRows(env)).rows.find((r) => r.id === rowId);
  if (!row) return json(req, 404, { ok: false, error: "no_row", message: "That follow-up isn't on the list anymore." });
  const list = await readReqs(env), now = Date.now();
  const lastHour = list.filter((q) => q.createdAt > now - 3600000);
  if (lastHour.length >= REQ_PER_HOUR) { const wait = Math.ceil((Math.min(...lastHour.map((q) => q.createdAt)) + 3600000 - now) / 1000);
    return json(req, 429, { ok: false, error: "too_many", message: "That's 20 requests this hour. Try again in " + Math.ceil(wait / 60) + " minutes.", retryAfter: wait }); }
  const q = { id: "rq-" + now.toString(36) + randHex(4), rowId, kind, note, status: "queued", result: "", createdAt: now, updatedAt: now };
  list.push(q); await writeReqs(env, list);
  await addEvents(env, [ev(by, "Asked Front Desk: " + REQ_KINDS[kind] + " for " + title(row), "bot")]);
  const w = await callFrontDesk(env, { action: "request", requestId: q.id });
  if (!w.ok) return json(req, 502, { ok: false, error: "webhook_failed", webhookStatus: w.status, request: q, message: "Saved, but the Front Desk bot didn't answer. It will see this on its next check." });
  return json(req, 200, { ok: true, webhookStatus: w.status, request: q });
}

async function runSweep(req, env, by, opts) {
  if (!connected(env)) return json(req, 503, { ok: false, error: "not_configured", message: "Run update isn't connected yet.", connected: false });
  const meta = (await env.KV.get(KEY_SWEEP, "json")) || {};
  const active = activeRunning(meta);
  if (active) return json(req, 409, { ok: false, error: "running", running: true, startedAt: active.startedAt, lastRunRequested: meta.lastRunRequested || null, lastSweepFinished: meta.lastSweepFinished || null, message: "A sweep is already running." });
  if (opts && opts.start === false) return json(req, 401, { ok: false, error: "pin_required", message: "Sign in with your PIN to start a sweep." });
  const prev = meta.lastRunRequested || null;
  const last = prev ? Date.parse(prev) : 0;
  const wait = Math.ceil((last + RUN_EVERY_MS - Date.now()) / 1000);
  if (wait > 0) return json(req, 429, { ok: false, error: "too_soon", message: "An update just started. Try again in " + (wait > 60 ? Math.ceil(wait / 60) + " minutes." : wait + " seconds."), retryAfter: wait, lastRunRequested: prev, running: false, startedAt: null });
  const requestedAt = new Date().toISOString();
  meta.lastRunRequested = requestedAt;
  meta.running = { startedAt: requestedAt, by: str(by, 60) || "RK" };
  await env.KV.put(KEY_SWEEP, JSON.stringify(meta));
  const resp = await callFrontDesk(env, { action: "sweep", requestedAt });
  if (!resp.ok) { // failed: don't hold RK to the 5-minute wait, and don't leave the running flag on
    meta.lastRunRequested = prev; delete meta.running; await env.KV.put(KEY_SWEEP, JSON.stringify(meta));
    if (!resp.status) return json(req, 502, { ok: false, error: "webhook_unreachable", message: "Couldn't reach the Front Desk bot.", lastRunRequested: prev, running: false, startedAt: null });
    return json(req, 502, { ok: false, webhookStatus: resp.status, lastRunRequested: prev, running: false, startedAt: null, message: "The Front Desk bot didn't accept the request (HTTP " + resp.status + ")." });
  }
  await addEvents(env, [ev(by, "Started a follow-up sweep", "bot")]);
  return json(req, 200, { ok: true, webhookStatus: resp.status, lastRunRequested: requestedAt, running: true, startedAt: requestedAt, message: "Sweep started" });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });

    if (path === "/" || path === "/status") {
      if (req.method !== "GET") return json(req, 405, { ok: false, error: "method" });
      return json(req, 200, { ok: true, service: "penguin-hq-api", setup: !!(env.PIN_SALT && env.PIN_HASH) });
    }

    if (path === "/hq/ws/followups") {
      if (req.method === "POST") {
        if (!(await tokenOk(req, env))) return json(req, 401, { ok: false, error: "bad_token" });
        const body = await readJson(req);
        if (!body || (!Array.isArray(body.rows) && !Array.isArray(body.deleted))) return json(req, 400, { ok: false, error: "bad_body", message: "Need {rows: [...]} and/or {deleted: [...]}" });
        const r = await writeRows(env, body, "patch", body.by || "Bot");
        return json(req, 200, { ok: true, added: r.added, updated: r.changed, removed: r.removed, total: r.st.rows.length });
      }
      if (req.method !== "GET" && req.method !== "PUT") return json(req, 405, { ok: false, error: "method" });
      if (req.method === "GET" && req.headers.get("Authorization")) { // Front Desk read token: read-only
        if (!(await tokenOk(req, env, "HQ_FRONTDESK_READ_TOKEN_HASH"))) return json(req, 401, { ok: false, error: "bad_token" });
        return json(req, 200, { ok: true, state: await readRows(env), statuses: STATUSES });
      }
      const bad = await checkPin(req, env); if (bad) return bad;
      if (req.method === "GET") return json(req, 200, { ok: true, state: await readRows(env), statuses: STATUSES });
      const body = await readJson(req);
      if (!body || !Array.isArray(body.rows)) return json(req, 400, { ok: false, error: "bad_state", message: "Need {rows: [], deleted: []}" });
      const r = await writeRows(env, body, "replace", "RK");
      return json(req, 200, { ok: true, state: r.st });
    }
    if (path === "/hq/ws") { // counts, same shape as video-library-api, followups only
      if (req.method !== "GET") return json(req, 405, { ok: false, error: "method" });
      const bad = await checkPin(req, env); if (bad) return bad;
      const st = await readRows(env); const by = {};
      st.rows.forEach((r) => { by[r.status] = (by[r.status] || 0) + 1; });
      return json(req, 200, { ok: true, workspaces: { followups: { label: "Follow-ups", statuses: STATUSES, count: st.rows.length, byStatus: by, needsRK: st.rows.filter((r) => r.needsRK).length } } });
    }

    if (path === "/hq/followups/status") {
      const meta = (await env.KV.get(KEY_SWEEP, "json")) || {};
      if (req.method === "POST") {
        if (!(await tokenOk(req, env))) return json(req, 401, { ok: false, error: "bad_token" });
        const body = await readJson(req) || {};
        const skipped = str(body.status, 20).toLowerCase() === "skipped";
        const hasFinish = !!str(body.finishedAt, 40);
        if (body.running === true && !hasFinish && !skipped) {
          const t0 = Date.parse(body.startedAt || "");
          const startedAt = isFinite(t0) ? new Date(t0).toISOString() : new Date().toISOString();
          meta.running = { startedAt, by: str(body.by, 60) || "Front Desk" };
          meta.lastRunRequested = startedAt;
          await env.KV.put(KEY_SWEEP, JSON.stringify(meta));
          return json(req, 200, Object.assign({ ok: true, connected: connected(env), lastRunRequested: meta.lastRunRequested, lastSweepFinished: meta.lastSweepFinished || null }, runningFields(meta)));
        }
        delete meta.running;
        if (skipped && !hasFinish) {
          await env.KV.put(KEY_SWEEP, JSON.stringify(meta));
          return json(req, 200, Object.assign({ ok: true, connected: connected(env), skipped: true, lastRunRequested: meta.lastRunRequested || null, lastSweepFinished: meta.lastSweepFinished || null }, runningFields(meta)));
        }
        const t = Date.parse(body.finishedAt || "");
        meta.lastSweepFinished = { at: isFinite(t) ? new Date(t).toISOString() : new Date().toISOString(), by: str(body.by, 60) || "Front Desk", summary: str(body.summary, 300) };
        await env.KV.put(KEY_SWEEP, JSON.stringify(meta));
        await addEvents(env, [ev(meta.lastSweepFinished.by, "Finished a follow-up sweep" + (meta.lastSweepFinished.summary ? ": " + meta.lastSweepFinished.summary : ""), "bot")]);
        return json(req, 200, Object.assign({ ok: true, connected: connected(env), lastSweepFinished: meta.lastSweepFinished, lastRunRequested: meta.lastRunRequested || null }, runningFields(meta)));
      }
      if (req.method !== "GET") return json(req, 405, { ok: false, error: "method" });
      if (req.headers.get("Authorization")) {
        if (!(await tokenOk(req, env)) && !(await tokenOk(req, env, "HQ_FRONTDESK_READ_TOKEN_HASH"))) return json(req, 401, { ok: false, error: "bad_token" });
      } else {
        const bad = await checkPin(req, env); if (bad) return bad;
      }
      return json(req, 200, Object.assign({ ok: true, connected: connected(env), lastRunRequested: meta.lastRunRequested || null, lastSweepFinished: meta.lastSweepFinished || null }, runningFields(meta)));
    }

    // "Run update": RK (PIN) -> Worker POSTs the Front Desk routine webhook. URL/key live only in Worker secrets.
    if (path === "/hq/followups/run") {
      if (req.method !== "POST") return json(req, 405, { ok: false, error: "method" });
      // Write token may only observe a 409 (already running). Starting a sweep still needs the PIN, so we never fire the webhook from a token call.
      if (req.headers.get("Authorization")) {
        if (!(await tokenOk(req, env))) return json(req, 401, { ok: false, error: "bad_token" });
        return runSweep(req, env, "Bot", { start: false });
      }
      const bad = await checkPin(req, env); if (bad) return bad;
      return runSweep(req, env, "RK");
    }

    // RK (PIN) sends a request about one row to the Front Desk bot.
    if (path === "/hq/followups/request") {
      if (req.method !== "POST") return json(req, 405, { ok: false, error: "method" });
      const bad = await checkPin(req, env); if (bad) return bad;
      return createRequest(req, env, await readJson(req) || {}, "RK");
    }
    // GET: Front Desk (read token, with row data) or the app (PIN). POST: Front Desk posts status/result (write token).
    if (path === "/hq/followups/requests") {
      if (req.method === "GET") {
        if (req.headers.get("Authorization")) { if (!(await tokenOk(req, env, "HQ_FRONTDESK_READ_TOKEN_HASH"))) return json(req, 401, { ok: false, error: "bad_token" }); }
        else { const bad = await checkPin(req, env); if (bad) return bad; }
        const want = (url.searchParams.get("status") || "all").split(",").filter((x) => x === "all" || REQ_STATUSES.includes(x));
        const id = url.searchParams.get("id");
        const rows = new Map((await readRows(env)).rows.map((r) => [r.id, r]));
        const out = (await readReqs(env)).filter((q) => (!id || q.id === id) && (want.includes("all") || want.includes(q.status))).map((q) => Object.assign({}, q, { kindLabel: REQ_KINDS[q.kind], row: rows.get(q.rowId) || null }));
        return json(req, 200, { ok: true, requests: out });
      }
      if (req.method !== "POST") return json(req, 405, { ok: false, error: "method" });
      if (!(await tokenOk(req, env))) return json(req, 401, { ok: false, error: "bad_token" });
      const body = await readJson(req) || {};
      const list = await readReqs(env);
      if (Array.isArray(body.deleted)) { const del = new Set(body.deleted.filter((x) => typeof x === "string")); const left = list.filter((q) => !del.has(q.id)); await writeReqs(env, left); return json(req, 200, { ok: true, removed: list.length - left.length }); }
      const q = list.find((x) => x.id === str(body.id, 64));
      if (!q) return json(req, 404, { ok: false, error: "no_request" });
      if (!REQ_STATUSES.includes(body.status) || body.status === "queued") return json(req, 400, { ok: false, error: "bad_status", message: "status must be working, needs_rk, done or failed." });
      const was = q.status;
      q.status = body.status; if (body.result !== undefined) q.result = str(body.result, 2000); q.updatedAt = Date.now();
      await writeReqs(env, list);
      if (was !== q.status && q.status !== "working") { const row = (await readRows(env)).rows.find((r) => r.id === q.rowId);
        await addEvents(env, [ev(str(body.by, 60) || "Front Desk", REQ_KINDS[q.kind] + " for " + (row ? title(row) : "a follow-up") + ": " + ({ needs_rk: "needs you", done: "done", failed: "failed" })[q.status], "bot")]); }
      return json(req, 200, { ok: true, request: q });
    }
    // Follow-ups activity (merged into HQ's feed by the app).
    if (path === "/hq/activity") {
      if (req.method !== "GET") return json(req, 405, { ok: false, error: "method" });
      const bad = await checkPin(req, env); if (bad) return bad;
      return json(req, 200, { ok: true, events: ((await env.KV.get(KEY_ACT, "json")) || { events: [] }).events });
    }
    /*BOOTSTRAP*/
    return json(req, 404, { ok: false, error: "not_found" });
  }
};
