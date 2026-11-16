// penguin-dispatch-map — Cloudflare Worker for the Penguin HQ Map tab. Read-only copy of the ServiceTitan dispatch board.
// Owner: W - Adam-Field Admin bot. Does not write to ServiceTitan or to any other Worker's data.
// Reads:  GET /dispatch?date=YYYY-MM-DD   needs the HQ PIN (X-PIN), checked by penguin-hq-api (service binding HQ, GET /hq/ws, read-only)
//         GET /dispatch/dates               same PIN, lists stored dates
// Writes: PUT /dispatch?date=YYYY-MM-DD   Authorization: Bearer <DISPATCH_MAP_WRITE_TOKEN> (secret WRITE_TOKEN_HASH = SHA-256 hex)
//         GET/POST /geocache               same bearer token; geocode cache {addressKey: {lat,lng,src}}
const ORIGIN = "https://rkem1800-sketch.github.io";
const PIN_OK_TTL = 600, FAIL_MAX = 10, FAIL_WINDOW = 900, MAX_BODY = 500000;

function cors(req) {
  const h = { "Vary": "Origin" };
  if (req.headers.get("Origin") === ORIGIN) {
    h["Access-Control-Allow-Origin"] = ORIGIN;
    h["Access-Control-Allow-Methods"] = "GET, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, X-PIN";
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
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function readJson(req) { try { const t = await req.text(); if (t.length > MAX_BODY) return null; return JSON.parse(t || "{}"); } catch (e) { return null; } }
function validDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d || ""); }

async function tokenOk(req, env) {
  const tok = (req.headers.get("Authorization") || "").replace(/^bearer\s+/i, "").trim();
  if (!tok || tok.length > 200 || !env.WRITE_TOKEN_HASH) return false;
  return safeEq(await sha256Hex(tok), String(env.WRITE_TOKEN_HASH).toLowerCase());
}
// Same HQ PIN. Verified by asking penguin-hq-api (read-only counts endpoint); it applies its own lockout too.
async function checkPin(req, env) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const fk = "fails:" + ip;
  const fails = (await env.KV.get(fk, "json")) || { n: 0 };
  if (fails.n >= FAIL_MAX) return json(req, 429, { ok: false, error: "locked", message: "Too many wrong PINs. Try again in 15 minutes." });
  const pin = req.headers.get("X-PIN") || "";
  if (!pin) return json(req, 401, { ok: false, error: "pin_required", message: "Sign in with your PIN on Home first." });
  if (pin.length > 64) return json(req, 401, { ok: false, error: "bad_pin", message: "Wrong PIN." });
  const ph = await sha256Hex("dispatch-map:" + pin);
  if (await env.KV.get("pinok:" + ph)) return null;
  let st = 0;
  try {
    const r = await env.HQ.fetch(new Request("https://penguin-hq-api/hq/ws", { headers: { "X-PIN": pin } }));
    st = r.status;
  } catch (e) { return json(req, 502, { ok: false, error: "pin_check_failed", message: "Couldn't check the PIN. Try again." }); }
  if (st === 200) {
    await env.KV.put("pinok:" + ph, "1", { expirationTtl: PIN_OK_TTL });
    if (fails.n) await env.KV.delete(fk);
    return null;
  }
  if (st === 429) return json(req, 429, { ok: false, error: "locked", message: "Too many wrong PINs. Try again in 15 minutes." });
  if (st === 401) {
    await env.KV.put(fk, JSON.stringify({ n: fails.n + 1 }), { expirationTtl: FAIL_WINDOW });
    return json(req, 401, { ok: false, error: "bad_pin", message: "Wrong PIN." });
  }
  return json(req, 502, { ok: false, error: "pin_check_failed", message: "Couldn't check the PIN (" + st + ")." });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });

    if (path === "/" || path === "/status") return json(req, 200, { ok: true, service: "penguin-dispatch-map" });

    if (path === "/dispatch") {
      const date = url.searchParams.get("date") || "";
      if (!validDate(date)) return json(req, 400, { ok: false, error: "bad_date", message: "Use ?date=YYYY-MM-DD" });
      if (req.method === "PUT") {
        if (!(await tokenOk(req, env))) return json(req, 401, { ok: false, error: "bad_token" });
        const body = await readJson(req);
        if (!body || !Array.isArray(body.jobs)) return json(req, 400, { ok: false, error: "bad_body", message: "Need {jobs: [...]}" });
        const board = { date, updatedAt: body.updatedAt || new Date().toISOString(), source: body.source || "ServiceTitan dispatch board (read-only)", notes: Array.isArray(body.notes) ? body.notes : [], jobs: body.jobs, storedAt: new Date().toISOString() };
        await env.KV.put("board:" + date, JSON.stringify(board));
        const idx = (await env.KV.get("board:index", "json")) || [];
        if (idx.indexOf(date) === -1) { idx.push(date); idx.sort(); await env.KV.put("board:index", JSON.stringify(idx.slice(-120))); }
        return json(req, 200, { ok: true, date, jobs: board.jobs.length });
      }
      if (req.method !== "GET") return json(req, 405, { ok: false, error: "method" });
      if (!(req.headers.get("Authorization") && await tokenOk(req, env))) { const bad = await checkPin(req, env); if (bad) return bad; }
      const board = await env.KV.get("board:" + date, "json");
      if (!board) return json(req, 404, { ok: false, error: "no_board", date, message: "No board saved for " + date + " yet." });
      return json(req, 200, { ok: true, board });
    }
    if (path === "/dispatch/dates") {
      if (req.method !== "GET") return json(req, 405, { ok: false, error: "method" });
      if (!(req.headers.get("Authorization") && await tokenOk(req, env))) { const bad = await checkPin(req, env); if (bad) return bad; }
      return json(req, 200, { ok: true, dates: (await env.KV.get("board:index", "json")) || [] });
    }
    if (path === "/geocache") {
      if (!(await tokenOk(req, env))) return json(req, 401, { ok: false, error: "bad_token" });
      const cache = (await env.KV.get("geocache", "json")) || {};
      if (req.method === "GET") return json(req, 200, { ok: true, cache });
      if (req.method === "POST") {
        const body = await readJson(req);
        if (!body || typeof body.entries !== "object") return json(req, 400, { ok: false, error: "bad_body" });
        for (const [k, v] of Object.entries(body.entries)) if (v && typeof v.lat === "number" && typeof v.lng === "number") cache[k] = { lat: v.lat, lng: v.lng, src: String(v.src || ""), at: v.at || new Date().toISOString() };
        await env.KV.put("geocache", JSON.stringify(cache));
        return json(req, 200, { ok: true, size: Object.keys(cache).length });
      }
      return json(req, 405, { ok: false, error: "method" });
    }
    return json(req, 404, { ok: false, error: "not_found" });
  }
};
