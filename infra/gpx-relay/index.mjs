// Beeline full-track GPX relay — a tiny, stateless AWS Lambda (Node 24, zero deps)
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
//     Origin allow-list, strict rideId validation, and a per-account + per-IP rate
//     limit (durable in DynamoDB when DDB_TABLE is set, else best-effort in-memory).
//     Pair this with a low Lambda *reserved concurrency* and an AWS Budgets alert.
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

// Single GLOBAL ceiling on successful downloads per calendar month (UTC), with NO
// per-account / per-IP bucketing — a coarse cost stop-loss on top of the per-bucket
// limits above. In warm-container memory only (it resets on cold start and is
// enforced per container). With reserved concurrency = 1 (one container at a time,
// the deploy default) this is an EXACT monthly ceiling; at higher concurrency it
// degrades to a best-effort per-container cap.
const RL_GLOBAL_PER_MONTH = intEnv("RL_GLOBAL_PER_MONTH", 10000);

// Reject absurdly large upstream bodies defensively (a ride GPX gz is tens of KB).
const MAX_BYTES = intEnv("MAX_BYTES", 12 * 1024 * 1024);

// Optional DURABLE persistence (AWS DynamoDB). When DDB_TABLE is set, the rate-limit
// counters, the global monthly cap and the lifetime stats live in a shared DynamoDB
// table instead of warm-container memory — so they survive cold starts AND are exact
// across concurrent containers (which is what lets reserved concurrency safely exceed
// 1). The AWS SDK v3 is provided by the Lambda Node 24 runtime, so the deploy zip stays
// dependency-free. When DDB_TABLE is empty the relay keeps its in-memory behaviour and
// needs no AWS permissions. Persistence errors FAIL CLOSED (no upstream egress) so the
// cost ceiling holds even during a DynamoDB outage; the app then falls back to its
// route-only GPX.
const DDB_TABLE = process.env.DDB_TABLE || "";
const DDB_ENABLED = DDB_TABLE.length > 0;

function intEnv(name, dflt) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// -- runtime stats + global monthly cap (in warm-container memory) ------------
// Captured once at module load == container cold start. These let a plain GET to
// the Function URL report basic liveness (when this container started, how many
// downloads it has served) so you can observe restart behaviour / container
// lifetime. None of this survives a cold start — that's the whole point.
const STARTED_AT = Date.now();
const INSTANCE_ID = randomId();
let downloadsServed = 0; // successful downloads this container has handed back (lifetime)
let globalMonth = monthKey(STARTED_AT); // UTC "YYYY-MM" the monthly counter belongs to
let globalMonthCount = 0; // successful downloads counted in the current month window
let lastCounterError = null; // name of the last post-download DynamoDB counter write that failed

function randomId() {
  try {
    return globalThis.crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(16).slice(2, 10);
  }
}

/** UTC "YYYY-MM" key for a given epoch-ms instant (the global cap's window). */
function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Seconds from `now` until the start of next UTC month (a Retry-After hint). */
function secondsToNextMonth(now) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

/** Roll the monthly window if the calendar month changed; returns the live count. */
function rollGlobalMonth(now) {
  const key = monthKey(now);
  if (key !== globalMonth) {
    globalMonth = key;
    globalMonthCount = 0;
  }
  return globalMonthCount;
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

// -- durable store (DynamoDB) ------------------------------------------------
// A single table keyed by `pk` (string), each counter a `n` (number) attribute, with
// an optional `ttl` (epoch-seconds) so DynamoDB auto-expires the rate-limit windows for
// free. Atomic `ADD` increments are race-free across containers, so the returned count
// is authoritative. The SDK is imported ONCE (lazily, only when DDB_TABLE is set; it's
// provided by the Lambda runtime so the zip stays dependency-free) and the client is
// reused. Every helper throws on infrastructure failure so callers can FAIL CLOSED.
let ddbModulePromise = null;
let ddbClientInstance = null;
async function ddbSend(commandName, input) {
  if (!ddbModulePromise) ddbModulePromise = import("@aws-sdk/client-dynamodb");
  const mod = await ddbModulePromise;
  if (!ddbClientInstance) ddbClientInstance = new mod.DynamoDBClient({});
  const Command = mod[commandName];
  return ddbClientInstance.send(new Command(input));
}

/** Atomically increment `pk`'s counter by 1 and return the NEW value. When `ttlSec` is
 *  given it's written as the item's TTL (epoch seconds) so DynamoDB reaps it later. */
async function ddbAddCount(pk, ttlSec) {
  const out = await ddbSend("UpdateItemCommand", {
    TableName: DDB_TABLE,
    Key: { pk: { S: pk } },
    UpdateExpression: ttlSec ? "ADD #n :one SET #t = :ttl" : "ADD #n :one",
    ExpressionAttributeNames: ttlSec ? { "#n": "n", "#t": "ttl" } : { "#n": "n" },
    ExpressionAttributeValues: ttlSec
      ? { ":one": { N: "1" }, ":ttl": { N: String(ttlSec) } }
      : { ":one": { N: "1" } },
    ReturnValues: "UPDATED_NEW",
  });
  return Number.parseInt(out.Attributes?.n?.N ?? "0", 10);
}

/** Strongly-consistent read of `pk`'s counter (0 when the item doesn't exist). */
async function ddbGetCount(pk) {
  const out = await ddbSend("GetItemCommand", {
    TableName: DDB_TABLE,
    Key: { pk: { S: pk } },
    ConsistentRead: true,
    ProjectionExpression: "#n",
    ExpressionAttributeNames: { "#n": "n" },
  });
  // GetItem returns the row under `Item` (UpdateItem uses `Attributes`).
  return Number.parseInt(out.Item?.n?.N ?? "0", 10);
}

/** Fixed-window keys + TTLs for the per-bucket limiter (DynamoDB path). */
function minuteWindow(now) {
  const slot = Math.floor(now / 60_000);
  return { end: (slot + 1) * 60_000, ttl: Math.floor(((slot + 1) * 60_000) / 1000) + 60 };
}
function dayWindow(now) {
  const slot = Math.floor(now / 86_400_000);
  return {
    end: (slot + 1) * 86_400_000,
    ttl: Math.floor(((slot + 1) * 86_400_000) / 1000) + 86_400,
  };
}

/** Apply all pre-egress gates (per-bucket minute+day limit, then the global monthly
 *  cap). Returns `{ ok }` or `{ ok:false, status, error, retryAfter }`. The DynamoDB
 *  path THROWS on store failure so the handler can fail closed. */
async function checkGates(bucket, now) {
  if (!DDB_ENABLED) {
    const rl = rateLimit(bucket, now);
    if (!rl.ok)
      return { ok: false, status: 429, error: "rate limit exceeded", retryAfter: rl.retryAfter };
    if (rollGlobalMonth(now) >= RL_GLOBAL_PER_MONTH)
      return {
        ok: false,
        status: 429,
        error: "monthly download limit reached",
        retryAfter: secondsToNextMonth(now),
      };
    return { ok: true };
  }
  const min = minuteWindow(now);
  if ((await ddbAddCount(`min#${bucket}#${Math.floor(now / 60_000)}`, min.ttl)) > RL_PER_MIN)
    return {
      ok: false,
      status: 429,
      error: "rate limit exceeded",
      retryAfter: Math.max(1, Math.ceil((min.end - now) / 1000)),
    };
  const day = dayWindow(now);
  if ((await ddbAddCount(`day#${bucket}#${Math.floor(now / 86_400_000)}`, day.ttl)) > RL_PER_DAY)
    return {
      ok: false,
      status: 429,
      error: "rate limit exceeded",
      retryAfter: Math.max(1, Math.ceil((day.end - now) / 1000)),
    };
  if ((await ddbGetCount(`month#${monthKey(now)}`)) >= RL_GLOBAL_PER_MONTH)
    return {
      ok: false,
      status: 429,
      error: "monthly download limit reached",
      retryAfter: secondsToNextMonth(now),
    };
  return { ok: true };
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

  // Runtime stats — a plain GET returns this container's basic liveness counters.
  // No auth, no rate limit, and deliberately NOT gated by ENABLED: it's a
  // diagnostic, so it must answer even when downloads are disabled. Exposes no
  // token / uid / ride data — just timings and counts.
  if (method === "GET") {
    const now = Date.now();
    if (DDB_ENABLED) {
      // Durable counts from the shared table (best-effort: a diagnostic, not egress,
      // so a store blip reports `storeError` rather than failing).
      let downloads = null;
      let monthlyDownloads = null;
      let storeError = false;
      try {
        monthlyDownloads = await ddbGetCount(`month#${monthKey(now)}`);
        downloads = await ddbGetCount("stats");
      } catch {
        storeError = true;
      }
      return json(200, origin, {
        startedAt: new Date(STARTED_AT).toISOString(),
        uptimeSeconds: Math.floor((now - STARTED_AT) / 1000),
        instanceId: INSTANCE_ID,
        persistence: "dynamodb",
        downloads,
        containerDownloads: downloadsServed,
        month: monthKey(now),
        monthlyDownloads,
        monthlyLimit: RL_GLOBAL_PER_MONTH,
        storeError,
        lastCounterError,
        enabled: ENABLED,
      });
    }
    rollGlobalMonth(now);
    return json(200, origin, {
      startedAt: new Date(STARTED_AT).toISOString(),
      uptimeSeconds: Math.floor((now - STARTED_AT) / 1000),
      instanceId: INSTANCE_ID,
      persistence: "memory",
      downloads: downloadsServed,
      month: globalMonth,
      monthlyDownloads: globalMonthCount,
      monthlyLimit: RL_GLOBAL_PER_MONTH,
      enabled: ENABLED,
    });
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

  // Rate limit (per account, falling back to IP) + the single GLOBAL monthly ceiling,
  // ALL gated BEFORE any upstream egress. Durable in DynamoDB when DDB_TABLE is set
  // (exact across containers), else best-effort in warm-container memory. The monthly
  // cap counts only successful downloads, so a request blocked here never consumed
  // quota. A persistence failure FAILS CLOSED (503, no egress) so the cost ceiling
  // holds even during a DynamoDB outage — the app then falls back to route-only GPX.
  const bucket = uidFromToken(idToken) || `ip:${ip}`;
  const now = Date.now();
  let gate;
  try {
    gate = await checkGates(bucket, now);
  } catch (err) {
    console.warn(`rate-limit store unavailable (failing closed): ${err?.name || err}`);
    return json(503, origin, { error: "rate-limit store unavailable" }, {
      "Retry-After": "30",
    });
  }
  if (!gate.ok) {
    return json(gate.status, origin, { error: gate.error }, {
      "Retry-After": String(gate.retryAfter),
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

  // Count the successful download against the lifetime stat and the global monthly
  // window. Durable in DynamoDB when enabled (best-effort here: the bytes are already
  // fetched, so a post-egress counting blip is logged, not surfaced — the NEXT request's
  // pre-egress gate would fail closed if the store were truly down). In-memory otherwise.
  if (DDB_ENABLED) {
    try {
      await ddbAddCount(`month#${monthKey(Date.now())}`);
      await ddbAddCount("stats");
      lastCounterError = null;
    } catch (err) {
      lastCounterError = err?.name || String(err);
      console.warn(`download counter update failed: ${err?.name || err}`);
    }
    downloadsServed++;
  } else {
    downloadsServed++;
    rollGlobalMonth(Date.now());
    globalMonthCount++;
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
