// Beeline full-track GPX relay — a tiny, stateless AWS Lambda (Node 20, zero deps)
// behind a Function URL. It exists for ONE reason: the browser cannot finish the
// full-GPX download itself. The authenticated Firebase Storage GET
// (`firebasestorage.…/?alt=media`) 302-redirects to a Google download host that
// returns NO `Access-Control-Allow-Origin`, so the browser blocks the cross-origin
// read. This relay performs both export hops server-side (where CORS does not apply)
// and streams the gzipped GPX back to the page with permissive CORS headers.
//
// What it does, per request:
//   1. POST {FUNCTIONS}/exportRide  Authorization: Bearer <idToken>  {data:{rideId}}
//        -> { result: "ride-gpx-export/<uid>/<pushId>.gpx.gz" }   (a Storage path)
//   2. GET {STORAGE}/v0/b/<bucket>/o/<urlenc path>?alt=media  Authorization: Firebase <idToken>
//        -> gzipped GPX bytes
//   3. return those bytes (base64, isBase64Encoded) — the browser gunzips them.
//
// SAFETY / COST (this is a PUBLIC URL you host — see infra/gpx-relay/README.md):
//   * The caller supplies only a `rideId`; the relay never takes a URL from the
//     client, so it cannot be turned into an open proxy (no SSRF).
//   * Requests are gated BEFORE any upstream call / data egress: kill-switch,
//     Origin allow-list, strict rideId validation, and a best-effort in-memory
//     per-account + per-IP rate limit. Pair this with a low Lambda *reserved
//     concurrency* (the real ceiling) and an AWS Budgets alert.
//   * Tokens are NEVER logged.
//
// Everything tunable is an env var (no redeploy to change a limit). See README.

const FUNCTIONS_BASE =
  process.env.FUNCTIONS_BASE || "https://us-central1-beeline-e46ed.cloudfunctions.net";
const STORAGE_BASE =
  process.env.STORAGE_BASE || "https://firebasestorage.googleapis.com";
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || "beeline-e46ed.appspot.com";

// Kill switch: set ENABLED=0 to instantly disable (returns 503; the app then falls
// back to its local route-only GPX). Default on.
const ENABLED = (process.env.ENABLED ?? "1") !== "0";

// Comma-separated origins allowed to call this relay from a browser. Empty list =
// reflect any origin (handy for local testing; lock this down in production).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Best-effort rate limits (per account uid AND per source IP). Generous defaults so
// a legitimate full-history backfill (a couple thousand rides) still completes.
const RL_PER_MIN = intEnv("RL_PER_MIN", 60);
const RL_PER_DAY = intEnv("RL_PER_DAY", 3000);

// Reject absurdly large upstream bodies defensively (a ride GPX gz is tens of KB).
const MAX_BYTES = intEnv("MAX_BYTES", 12 * 1024 * 1024);

function intEnv(name, dflt) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// -- best-effort rate limiter (in warm-container memory) ---------------------
// No external state store: counters live in the container and reset per fixed
// window. This is intentionally lightweight — combined with a low reserved
// concurrency (few containers) it effectively caps casual abuse for free. It is
// NOT a hard guarantee across many cold containers; the hard ceiling is reserved
// concurrency + the AWS Budgets alarm.
const minuteHits = new Map(); // id -> { windowStart, count }
const dayHits = new Map();

function hit(map, id, windowMs, limit, now) {
  const slot = map.get(id);
  if (!slot || now - slot.windowStart >= windowMs) {
    map.set(id, { windowStart: now, count: 1 });
    return { ok: true, retryAfter: 0 };
  }
  if (slot.count >= limit) {
    const retryAfter = Math.ceil((slot.windowStart + windowMs - now) / 1000);
    return { ok: false, retryAfter: Math.max(1, retryAfter) };
  }
  slot.count++;
  return { ok: true, retryAfter: 0 };
}

function rateLimit(id, now) {
  // Occasionally prune so the maps can't grow unbounded on a long-lived container.
  if (minuteHits.size > 5000) minuteHits.clear();
  if (dayHits.size > 50000) dayHits.clear();
  const m = hit(minuteHits, id, 60_000, RL_PER_MIN, now);
  if (!m.ok) return m;
  return hit(dayHits, id, 86_400_000, RL_PER_DAY, now);
}

// -- helpers ----------------------------------------------------------------

/** Decode a Firebase ID token's uid from its (unverified) JWT payload. Used ONLY
 *  as a rate-limit bucket key — Beeline still rejects a forged/expired token at the
 *  exportRide hop, so a spoofed bucket key gains nothing. */
function uidFromToken(idToken) {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const obj = JSON.parse(json);
    return obj.user_id || obj.sub || obj.uid || null;
  } catch {
    return null;
  }
}

function corsHeaders(origin) {
  // Reflect the caller's origin when allowed (no allow-list = reflect any). Auth is
  // a bearer header, never a cookie, so we never set allow-credentials.
  let allow = "";
  if (ALLOWED_ORIGINS.length === 0) allow = origin || "*";
  else if (origin && ALLOWED_ORIGINS.includes(origin)) allow = origin;
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allow) h["Access-Control-Allow-Origin"] = allow;
  return h;
}

function json(statusCode, origin, obj, extra = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin), ...extra },
    body: JSON.stringify(obj),
  };
}

function lower(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

// -- handler ----------------------------------------------------------------

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || "POST";
  const headers = lower(event?.headers);
  const origin = headers.origin || "";
  const ip = event?.requestContext?.http?.sourceIp || "unknown";

  // CORS preflight — answer before any work.
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }
  if (method !== "POST") {
    return json(405, origin, { error: "method not allowed" });
  }

  // Origin allow-list (when configured): refuse browsers from other sites outright.
  if (ALLOWED_ORIGINS.length > 0 && origin && !ALLOWED_ORIGINS.includes(origin)) {
    return json(403, origin, { error: "origin not allowed" });
  }

  // Kill switch.
  if (!ENABLED) {
    return json(503, origin, { error: "gpx relay disabled" });
  }

  // Auth must be a bearer token we forward upstream.
  const auth = headers.authorization || "";
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!idToken) {
    return json(401, origin, { error: "missing bearer token" });
  }

  // Parse + validate body. The only accepted input is a Firebase push id.
  let rideId;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "";
    rideId = JSON.parse(raw || "{}").rideId;
  } catch {
    return json(400, origin, { error: "invalid JSON body" });
  }
  if (typeof rideId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(rideId)) {
    return json(400, origin, { error: "invalid rideId" });
  }

  // Rate limit (per account, falling back to IP) BEFORE any upstream egress.
  const bucket = uidFromToken(idToken) || `ip:${ip}`;
  const rl = rateLimit(bucket, Date.now());
  if (!rl.ok) {
    return json(429, origin, { error: "rate limit exceeded" }, {
      "Retry-After": String(rl.retryAfter),
    });
  }

  // Hop 1 — ask Beeline to render the ride's full GPX; get back a Storage path.
  let exportRes;
  try {
    exportRes = await fetch(`${FUNCTIONS_BASE}/exportRide`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ data: { rideId } }),
    });
  } catch {
    return json(502, origin, { error: "upstream exportRide unreachable" });
  }
  const exportText = await exportRes.text().catch(() => "");
  if (!exportRes.ok) {
    // Partial rides (no recorded track) come back as a callable NOT_FOUND.
    if (/ride points|NOT_FOUND|not\s*found/i.test(exportText)) {
      return json(422, origin, { error: "ride has no recorded track to export" });
    }
    if (exportRes.status === 401 || exportRes.status === 403) {
      return json(401, origin, { error: "Beeline rejected the token" });
    }
    return json(502, origin, { error: `exportRide failed (HTTP ${exportRes.status})` });
  }
  let path;
  try {
    path = JSON.parse(exportText || "{}").result;
  } catch {
    path = undefined;
  }
  if (!path || typeof path !== "string") {
    return json(502, origin, { error: "exportRide returned no file path" });
  }

  // Hop 2 — download the gzipped GPX object from Firebase Storage.
  let storageRes;
  try {
    const url =
      `${STORAGE_BASE}/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media`;
    storageRes = await fetch(url, {
      headers: { Authorization: `Firebase ${idToken}` },
    });
  } catch {
    return json(502, origin, { error: "upstream storage unreachable" });
  }
  if (!storageRes.ok) {
    return json(502, origin, { error: `storage download failed (HTTP ${storageRes.status})` });
  }
  const buf = Buffer.from(await storageRes.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    return json(502, origin, { error: "exported GPX exceeds size limit" });
  }

  // Return the gzipped bytes verbatim (base64); the browser gunzips them. Returning
  // the gz (not the decompressed GPX) keeps egress ~10x smaller.
  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: {
      "Content-Type": "application/gpx+xml",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
    },
    body: buf.toString("base64"),
  };
};
