/**
 * Beeline cloud-backend client — the ride source.
 *
 * Reverse-engineered from a real traffic capture of the Beeline Velo 2 Android
 * app. It talks to the same Firebase backend the app uses and pulls the *entire*
 * ride history — with inline route polylines and Strava status — in a single
 * request.
 *
 * Three endpoints carry the whole flow:
 *
 *   1. AUTH   — Firebase Auth REST (Google Identity Toolkit)
 *        POST {IDENTITY}/verifyPassword?key=<API_KEY>
 *        headers X-Android-Package / X-Android-Cert  (the key is app-restricted)
 *        body {email,password,returnSecureToken:true}
 *        -> { idToken, refreshToken, localId (=uid), expiresIn }
 *
 *   2. RIDES  — Firebase Realtime Database REST
 *        GET {RTDB}/rides/<uid>.json?auth=<idToken>
 *        -> { "<rideId>": { polyline, totalDistance, averageSpeed, topSpeed,
 *                           movingTime, duration, start, end, strava_activity,
 *                           ... }, ... }     (one shot, ~2000 rides)
 *
 *   3. UPLOAD — Firebase Callable Cloud Function
 *        POST {FUNCTIONS}/uploadRideToStrava
 *        header Authorization: Bearer <idToken>
 *        body   {"data":{"rideId":"<rideId>"}}
 *      Progress is written back to rides/<uid>/<rideId>/strava_activity, which we
 *      re-read to observe the upload reaching a terminal state.
 *
 * Browser-friendly: all four endpoints send permissive CORS headers (the auth
 * endpoint even allows the X-Android-* headers from a web origin), so this runs
 * entirely in the SPA with no backend proxy. Only `fetch` is used.
 */

import { gunzip } from "./gzip";
import type { StravaStatus } from "./parsing";
import { beelineRideKey, timeOfDayName, timeOfDayNameFromHour } from "./parsing";
import type { RideSource, UpsertFields } from "./store";
import { decodePolyline, trackLengthKm } from "./track";

// Re-exported so existing importers (and tests) can keep pulling `gunzip` from here.
export { gunzip } from "./gzip";

// -- backend constants (from the capture; not secrets — they live in the APK) --
const FIREBASE_API_KEY = "AIzaSyDS48dtvbuXhM5mWwygLY7CM5kpFbe6L0U";
const RTDB_BASE = "https://beeline-e46ed.firebaseio.com";
const FUNCTIONS_BASE = "https://us-central1-beeline-e46ed.cloudfunctions.net";
const IDENTITY_BASE = "https://www.googleapis.com/identitytoolkit/v3/relyingparty";
// Firebase's secure-token host, which exchanges a long-lived refresh token for a
// fresh short-lived id token (`refreshSession`). Distinct host from IDENTITY_BASE
// and it speaks form-urlencoded, not JSON.
const SECURETOKEN_BASE = "https://securetoken.googleapis.com/v1/token";
// Firebase Storage REST host + bucket holding the server-rendered full-track GPX
// (`exportRide` writes `ride-gpx-export/<uid>/<pushId>.gpx.gz` here). The authed
// `?alt=media` GET 302-redirects to a Google download host that returns NO
// `Access-Control-Allow-Origin`, so the browser blocks it cross-origin. Under
// `npm run dev:proxy` (__BEELINE_DEV_PROXY__) we hit a same-origin `/bl-storage`
// path that the Vite dev server forwards (following the redirect server-side) to
// unblock local testing; production builds always use the real host (the flag is
// `false` in `vite build`). See vite.config.ts.
const STORAGE_BASE = __BEELINE_DEV_PROXY__
  ? "/bl-storage"
  : "https://firebasestorage.googleapis.com";
const STORAGE_BUCKET = "beeline-e46ed.appspot.com";
// Optional production relay for the full-track GPX (see infra/gpx-relay). When this
// is a non-empty URL, `exportRideGpx` routes the whole export through it instead of
// the two direct hops — the only way to finish the download in a production browser,
// where the Storage `?alt=media` redirect drops its CORS header. Empty in dev and in
// any backend-free build, so the direct path is used.
const GPX_RELAY_URL = __GPX_RELAY_URL__;
const ANDROID_PACKAGE = "co.beeline";
const ANDROID_CERT = "8DB76C76142E30EEF0D04F5BF738A4BAA6049642";

/** Raised for any Beeline backend failure (auth rejected, network, HTTP error). */
export class BeelineError extends Error {
  /**
   * Coarse cause, used by the GPX download to decide whether to degrade gracefully:
   * - `unreachable` — the export gateway/network couldn't be reached or returned a
   *   transient/disabled status. The caller may fall back to a route-only GPX.
   * - `no-track` — the ride genuinely has no recorded full track to export (a clear,
   *   non-retryable condition the user should see).
   * - `expired` — the session's id token was rejected as expired/invalid (HTTP
   *   401/403, or a failed refresh). The source uses this to renew + retry once.
   * - `other` — everything else (malformed responses, …).
   */
  readonly kind: "unreachable" | "no-track" | "expired" | "other";
  /** The HTTP status that caused this error, when one was received (else undefined). */
  readonly status?: number;
  constructor(
    message: string,
    kind: "unreachable" | "no-track" | "expired" | "other" = "other",
    status?: number,
  ) {
    super(message);
    this.name = "BeelineError";
    this.kind = kind;
    this.status = status;
  }
}

/** An authenticated session: a short-lived id token plus the user's uid. */
export interface BeelineSession {
  idToken: string;
  uid: string;
  email: string;
  /**
   * Firebase refresh token. Long-lived; used to silently mint a fresh `idToken`
   * (via `refreshSession`) when the current one is near expiry or rejected, so an
   * in-session batch that outlasts the ~1h token never breaks. Kept in memory only
   * (never persisted) — a reload drops it and the app re-prompts for the password.
   */
  refreshToken: string;
  /** Epoch ms after which `idToken` is expired (renewed silently via `refreshSession`). */
  expiresAt: number;
}

/**
 * The subset of a Beeline ride record we consume. The backend stores far more
 * (device firmware, elevation series, …); we read only what the app needs. All
 * fields are optional because older/partial rides omit many of them.
 */
export interface RawBeelineRide {
  /**
   * User-set ride name (e.g. "Let's go sailing"). Present ONLY on rides the user
   * has explicitly named in the Beeline app — the backend has no auto-title, so for
   * unnamed rides this is absent and we synthesize a time-of-day name instead.
   */
  name?: string;
  /** Route shape as a Google-encoded polyline (precision 5). */
  polyline?: string;
  /** Total distance in METRES. */
  totalDistance?: number;
  /** Average speed in METRES PER SECOND. */
  averageSpeed?: number;
  /** Top speed in METRES PER SECOND. */
  topSpeed?: number;
  /** Moving time in MILLISECONDS. */
  movingTime?: number;
  /** Elapsed time in MILLISECONDS. */
  duration?: number;
  /** Ride start as epoch MILLISECONDS (the unique-key anchor). */
  start?: number;
  /** Ride end as epoch MILLISECONDS. */
  end?: number;
  /** Total ascent in METRES (present only on some rides). */
  totalElevationGain?: number;
  /** Total descent in METRES (present only on some rides). */
  totalElevationLoss?: number;
  /** Highest point in METRES (present only on some rides). */
  maxElevation?: number;
  /**
   * Routed destination, if the ride navigated to one (~⅓ of rides). The reverse-
   * geocoded `address` is the only place information Beeline gives us — the backend
   * stores no ride title — so we build the card's location label from it.
   */
  destination?: {
    address?: {
      /** POI name, when the destination is a named place ("Juniper Networks"). */
      name?: string;
      /** City / town ("Amsterdam"). */
      locality?: string;
      /** Municipality / borough ("Amstelveen"). */
      subAdministrativeArea?: string;
      /** Province / state ("Noord-Holland"). */
      administrativeArea?: string;
    };
  };
  /** Strava upload bookkeeping; absent until an upload is first attempted. */
  strava_activity?: {
    id?: number;
    upload_id?: number;
    stravaUploadStatus?: { status?: string; timestamp?: number };
  };
}

// -- small fetch helper -----------------------------------------------------

async function request<T>(
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      // NEVER use credentials:"include" here. Beeline's auth rides in the `?auth=`
      // query param / `Authorization` header, not cookies, and credentialed mode
      // makes the browser reject Storage's wildcard `ACAO: *` and an `Origin: null`
      // (file://) match — turning every call into a CORS block. The default
      // ("same-origin") is what keeps the cross-origin reads/writes working from any
      // origin. Proven in temp/beeline-protocol.md §10.8.
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(opts.body !== undefined
          ? { "Content-Type": "application/json; charset=utf-8" }
          : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    // Network/DNS/CORS failure — fetch rejects without a response.
    throw new BeelineError(`network error talking to Beeline: ${(err as Error).message}`);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    // A rejected id token comes back as 401/403; tag it `expired` so the source can
    // renew the session and retry once rather than surfacing a hard failure.
    const kind = resp.status === 401 || resp.status === 403 ? "expired" : "other";
    throw new BeelineError(
      `Beeline ${method} ${shortUrl(url)} failed: HTTP ${resp.status} ${detail.slice(0, 300)}`,
      kind,
      resp.status,
    );
  }
  const text = await resp.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Strip the query string (which carries the auth token) from a URL for error messages. */
function shortUrl(url: string): string {
  const q = url.indexOf("?");
  return q >= 0 ? url.slice(0, q) : url;
}

// -- 1. auth ----------------------------------------------------------------

interface SignInResponse {
  idToken: string;
  refreshToken: string;
  localId: string;
  email: string;
  expiresIn: string;
}

/**
 * Map a Firebase Identity-Toolkit error code (carried in the verifyPassword 400
 * body, e.g. `EMAIL_NOT_FOUND`) to a short, human sign-in message. Firebase's raw
 * response — an HTTP line plus a nested JSON error blob — is unreadable to a user,
 * so we translate the codes we know and fall back to a generic line otherwise.
 */
function friendlySignInError(rawMessage: string): string {
  if (/EMAIL_NOT_FOUND/.test(rawMessage)) {
    return "No Beeline account found for that email.";
  }
  if (/INVALID_PASSWORD|INVALID_LOGIN_CREDENTIALS/.test(rawMessage)) {
    return "Incorrect email or password.";
  }
  if (/INVALID_EMAIL/.test(rawMessage)) {
    return "That doesn't look like a valid email address.";
  }
  if (/MISSING_PASSWORD/.test(rawMessage)) {
    return "Enter your Beeline password.";
  }
  if (/USER_DISABLED/.test(rawMessage)) {
    return "This Beeline account has been disabled.";
  }
  if (/TOO_MANY_ATTEMPTS_TRY_LATER|OPERATION_NOT_ALLOWED/.test(rawMessage)) {
    return "Too many sign-in attempts. Please wait a moment and try again.";
  }
  // Network/CORS failures keep their own message — they're already user-facing.
  if (/network error/i.test(rawMessage)) return rawMessage;
  return "Couldn't sign in to Beeline. Please check your email and password and try again.";
}

/** Sign in with Beeline (Firebase) email + password, returning a session. */
export async function signIn(email: string, password: string): Promise<BeelineSession> {
  let res: SignInResponse;
  try {
    res = await request<SignInResponse>(
      "POST",
      `${IDENTITY_BASE}/verifyPassword?key=${FIREBASE_API_KEY}`,
      {
        headers: { "X-Android-Package": ANDROID_PACKAGE, "X-Android-Cert": ANDROID_CERT },
        body: { email, password, returnSecureToken: true },
      },
    );
  } catch (err) {
    // Translate Firebase's raw HTTP/JSON error into a clean message; bad creds are
    // an `expired`/auth-class failure the caller treats as a sign-in rejection.
    const raw = err instanceof Error ? err.message : String(err);
    throw new BeelineError(friendlySignInError(raw), "expired");
  }
  return {
    idToken: res.idToken,
    uid: res.localId,
    email: res.email || email,
    refreshToken: res.refreshToken,
    expiresAt: Date.now() + (Number(res.expiresIn) || 3600) * 1000,
  };
}

interface RefreshResponse {
  id_token: string;
  refresh_token: string;
  expires_in: string;
  user_id: string;
}

/**
 * Silently renew a session's id token using its refresh token — no password needed.
 * Returns a NEW session (fresh `idToken`/`expiresAt`, and the rotated refresh token
 * when Firebase returns one). Throws a `BeelineError` of kind `expired` when the
 * refresh token itself is rejected (revoked / signed out elsewhere), so the caller
 * falls back to a full password sign-in.
 *
 * The secure-token endpoint speaks `application/x-www-form-urlencoded` (not JSON) and
 * the API key is Android-restricted, so it carries the same `X-Android-*` headers as
 * `verifyPassword`.
 */
export async function refreshSession(session: BeelineSession): Promise<BeelineSession> {
  let resp: Response;
  try {
    resp = await fetch(`${SECURETOKEN_BASE}?key=${FIREBASE_API_KEY}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Android-Package": ANDROID_PACKAGE,
        "X-Android-Cert": ANDROID_CERT,
      },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(session.refreshToken)}`,
    });
  } catch (err) {
    throw new BeelineError(
      `network error renewing Beeline session: ${(err as Error).message}`,
      "expired",
    );
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new BeelineError(
      `couldn't renew Beeline session: HTTP ${resp.status} ${detail.slice(0, 300)}`,
      "expired",
      resp.status,
    );
  }
  const res = JSON.parse(await resp.text()) as RefreshResponse;
  return {
    idToken: res.id_token,
    uid: res.user_id || session.uid,
    email: session.email,
    refreshToken: res.refresh_token || session.refreshToken,
    expiresAt: Date.now() + (Number(res.expires_in) || 3600) * 1000,
  };
}

// -- 2. rides ---------------------------------------------------------------

/** Fetch the entire ride history for a session in one request (keyed by push-id). */
export async function fetchRides(
  session: BeelineSession,
): Promise<Record<string, RawBeelineRide>> {
  const url = `${RTDB_BASE}/rides/${session.uid}.json?auth=${encodeURIComponent(session.idToken)}`;
  const data = await request<Record<string, RawBeelineRide> | null>("GET", url);
  return data ?? {};
}

/** Re-read one ride's Strava bookkeeping node (used to observe an upload settling). */
export async function fetchStravaActivity(
  session: BeelineSession,
  pushId: string,
): Promise<RawBeelineRide["strava_activity"]> {
  const url =
    `${RTDB_BASE}/rides/${session.uid}/${pushId}/strava_activity.json` +
    `?auth=${encodeURIComponent(session.idToken)}`;
  return request<RawBeelineRide["strava_activity"]>("GET", url);
}

// -- 3. strava upload -------------------------------------------------------

/** Kick off the server-side Strava upload for a ride (fire-and-forget; async). */
export async function uploadRideToStrava(
  session: BeelineSession,
  pushId: string,
): Promise<void> {
  await request("POST", `${FUNCTIONS_BASE}/uploadRideToStrava`, {
    headers: { Authorization: `Bearer ${session.idToken}` },
    body: { data: { rideId: pushId } },
  });
}

// -- 3b. full-track GPX export ----------------------------------------------
//
// The RTDB ride record only carries a downsampled `polyline` (lat/lon, no time or
// elevation). The app's "export GPX" is instead a SERVER-SIDE render behind the
// callable Cloud Function `exportRide`, which returns a Firebase Storage path to a
// gzipped GPX holding the real ~1 Hz recorded trace WITH per-point `<time>` and
// `<ele>`. See temp/beeline-protocol.md §6 (verified live). Two hops + a gunzip:
//   1. POST {FUNCTIONS}/exportRide  Bearer idToken  {data:{rideId}}
//        -> { result: "ride-gpx-export/<uid>/<pushId>.gpx.gz" }   (a Storage path)
//   2. GET {STORAGE}/v0/b/<bucket>/o/<urlenc path>?alt=media  Authorization: Firebase idToken
//        -> gzipped GPX bytes  ->  gunzip

/**
 * Export one ride's FULL recorded track as GPX bytes (decompressed text). This is
 * the genuine ~1 Hz trace with real timestamps and elevation — far richer than the
 * `polyline` in the ride record — fetched only on demand (it is ~500 KB/ride).
 * Throws a clear BeelineError when the ride has no recorded points to export.
 */
export async function exportRideGpx(
  session: BeelineSession,
  pushId: string,
): Promise<Uint8Array> {
  // In production the browser can't finish the direct download (the Storage redirect
  // drops its CORS header), so a deployment points at a relay that does both hops
  // server-side. When configured, route the whole export through it.
  if (GPX_RELAY_URL) return exportRideGpxViaRelay(session, pushId);

  let res: { result?: string };
  try {
    res = await request<{ result?: string }>("POST", `${FUNCTIONS_BASE}/exportRide`, {
      headers: { Authorization: `Bearer ${session.idToken}` },
      body: { data: { rideId: pushId } },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Partial rides (no on-device track) come back as a callable NOT_FOUND.
    if (/ride points|NOT_FOUND|not\s*found/i.test(msg)) {
      throw new BeelineError("ride has no recorded track to export", "no-track");
    }
    throw err;
  }
  const path = res.result;
  if (!path || typeof path !== "string") {
    throw new BeelineError("Beeline exportRide returned no GPX file path");
  }
  const gz = await downloadStorageObject(session, path);
  return gunzip(gz);
}

/**
 * Export a ride's full GPX through the production relay (see infra/gpx-relay). The
 * relay does both export hops server-side and returns the gzipped GPX. Failures are
 * tagged `unreachable` (network / disabled / 5xx / 429) so the caller can fall back
 * to a route-only GPX, or `no-track` (422) when the ride has nothing to export.
 */
async function exportRideGpxViaRelay(
  session: BeelineSession,
  pushId: string,
): Promise<Uint8Array> {
  let resp: Response;
  try {
    resp = await fetch(GPX_RELAY_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${session.idToken}`,
      },
      body: JSON.stringify({ rideId: pushId }),
    });
  } catch (err) {
    throw new BeelineError(
      `couldn't reach the GPX export gateway: ${(err as Error).message}`,
      "unreachable",
    );
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    if (resp.status === 422 || /ride points|no recorded track/i.test(detail)) {
      throw new BeelineError("ride has no recorded track to export", "no-track");
    }
    // Disabled (503), rate-limited (429) or any upstream 5xx: treat as unreachable
    // so the app degrades to a route-only GPX rather than hard-failing.
    if (resp.status === 503 || resp.status === 429 || resp.status >= 500) {
      throw new BeelineError(
        `GPX export gateway unavailable (HTTP ${resp.status})`,
        "unreachable",
      );
    }
    throw new BeelineError(
      `GPX export gateway error: HTTP ${resp.status} ${detail.slice(0, 200)}`,
    );
  }
  // The relay returns the gzipped GPX bytes verbatim; gunzip (a no-op on already
  // plain bytes) yields the GPX text.
  return gunzip(new Uint8Array(await resp.arrayBuffer()));
}

/** Download a Firebase Storage object's raw bytes by its object path. */
async function downloadStorageObject(
  session: BeelineSession,
  objectPath: string,
): Promise<Uint8Array> {
  const url =
    `${STORAGE_BASE}/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(objectPath)}` +
    `?alt=media`;
  let resp: Response;
  try {
    // Storage returns a wildcard `Access-Control-Allow-Origin: *` and allow-lists
    // the `Authorization` header, so this cross-origin GET is readable from any
    // origin — but ONLY with the default ("same-origin") credentials: a wildcard
    // ACAO is rejected by the browser under credentials:"include". Keep it default.
    // See temp/beeline-protocol.md §10.6/§10.8.
    resp = await fetch(url, {
      credentials: "same-origin",
      headers: { Authorization: `Firebase ${session.idToken}` },
    });
  } catch (err) {
    throw new BeelineError(
      `network error downloading GPX from Beeline storage: ${(err as Error).message}`,
      "unreachable",
    );
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new BeelineError(
      `Beeline storage download failed: HTTP ${resp.status} ${detail.slice(0, 300)}`,
    );
  }
  return new Uint8Array(await resp.arrayBuffer());
}

// -- 4. rename / delete -----------------------------------------------------

// Both are direct Realtime-Database writes (not Cloud Functions): the app's own
// RideRepository merges `{name}` into the ride node to rename and clears the node
// to delete (auth in the query string, RTDB-style). See temp/beeline-protocol.md §5a.

/** Rename a ride by merging a new `name` into its node (RTDB PATCH). */
export async function renameRide(
  session: BeelineSession,
  pushId: string,
  newName: string,
): Promise<void> {
  const url =
    `${RTDB_BASE}/rides/${session.uid}/${pushId}.json` +
    `?auth=${encodeURIComponent(session.idToken)}`;
  await request("PATCH", url, { body: { name: newName } });
}

/** Delete a ride by clearing its whole node (RTDB DELETE). */
export async function deleteRide(session: BeelineSession, pushId: string): Promise<void> {
  const url =
    `${RTDB_BASE}/rides/${session.uid}/${pushId}.json` +
    `?auth=${encodeURIComponent(session.idToken)}`;
  await request("DELETE", url);
}

// -- status mapping ---------------------------------------------------------

/** Strava upload-status strings the backend writes that mean "done, on Strava". */
const UPLOADED_STATES = new Set(["availableOnStrava", "finishedUploading"]);
/** Strings that mean an upload is mid-flight. */
const PROCESSING_STATES = new Set(["startedUploading", "uploading", "processing"]);
/** Strings that mean the upload failed and the ride can be retried. */
const FAILED_STATES = new Set(["uploadFailed", "error", "failed"]);

/** Map a ride's `strava_activity` node to the app's canonical StravaStatus. */
export function stravaStatusOf(ride: RawBeelineRide): StravaStatus {
  const act = ride.strava_activity;
  if (!act) return "pending"; // never uploaded → eligible to upload
  const status = act.stravaUploadStatus?.status ?? "";
  if (UPLOADED_STATES.has(status)) return "uploaded";
  if (PROCESSING_STATES.has(status)) return "processing";
  if (FAILED_STATES.has(status)) return "pending"; // failed → retryable
  // Has a strava_activity but an unrecognised/empty status: if a Strava id is
  // present the ride is effectively on Strava, otherwise leave it pending.
  return act.id ? "uploaded" : "pending";
}

/** True once a ride's Strava status has reached a terminal (non-processing) state. */
export function isTerminalStatus(status: StravaStatus): boolean {
  return status === "uploaded" || status === "pending";
}

// -- numeric conversion (Beeline SI units → the app's normalized metrics) ----
//
// The store now holds normalized numbers (distance_km, moving_sec, …), so the
// Beeline mapper converts its raw SI values (metres, m/s, milliseconds) straight
// into those metrics — no localized strings, and no number→string→number round
// trip through the parsers any more.

const MPS_TO_KMH = 3.6;

/**
 * The most specific human place for a ride's routed destination, or "" when the
 * ride has no destination (a free ride) or no usable address. Prefers a named POI,
 * then city, then municipality, then province — the reverse-geocoded address is the
 * only location data Beeline provides, and only for rides that navigated somewhere.
 */
function destinationPlace(raw: RawBeelineRide): string {
  const a = raw.destination?.address;
  if (!a) return "";
  return a.name || a.locality || a.subAdministrativeArea || a.administrativeArea || "";
}

// -- ride mapping -----------------------------------------------------------

/** Outcome of mapping one Beeline ride: its date-derived key + fields to upsert. */
export interface MappedBeelineRide {
  key: string;
  fields: UpsertFields;
}

/**
 * A resolved ride-local time for a Beeline ride: the wall-clock `key` + hour in the
 * ride's OWN timezone, plus that IANA zone. Computed by the source (async, needs the
 * lazily-loaded tz table) and threaded in so mapping stays a pure function.
 */
export interface RideZone {
  key: string;
  hour: number;
  iana: string;
}

/**
 * Map one raw Beeline ride (and its push-id) into a store key + UpsertFields.
 *
 * When a resolved `zone` is supplied the display key + default time-of-day name are
 * in the ride's OWN timezone (stable regardless of where the viewer is), and the
 * ride's `start_epoch` + `tz` are recorded. Without one (e.g. the per-ride detail
 * rebuild) it falls back to the browser-local datetime. The inline polyline is kept
 * in FULL as the `track` (already compact; the only route data we get). `source` /
 * `source_id` mark the ride Beeline-sourced and carry the push-id for later upload.
 *
 * Returns null when the ride has no parseable start time (no usable key).
 */
export function mapBeelineRide(
  pushId: string,
  raw: RawBeelineRide,
  sourceLabel: string,
  zone?: RideZone,
): MappedBeelineRide | null {
  if (!raw.start || !Number.isFinite(raw.start)) return null;
  const key = zone?.key || beelineRideKey(raw.start);
  if (!key) return null;

  const fields: UpsertFields = {
    source: "beeline" as RideSource,
    source_id: pushId,
    device_model: sourceLabel,
    strava_status: stravaStatusOf(raw),
    // The start is a fixed UTC instant — authoritative for sort + ride-local render.
    start_epoch: raw.start,
    key,
  };
  if (zone?.iana) fields.tz = zone.iana;
  if (typeof raw.strava_activity?.id === "number") {
    fields.strava_activity_id = raw.strava_activity.id;
  }

  // Metrics: convert Beeline's SI units straight into the app's normalized numbers.
  if (typeof raw.totalDistance === "number" && raw.totalDistance > 0) {
    fields.distance_km = raw.totalDistance / 1000;
  }
  if (typeof raw.averageSpeed === "number" && raw.averageSpeed > 0) {
    fields.avg_speed_kmh = raw.averageSpeed * MPS_TO_KMH;
  }
  if (typeof raw.topSpeed === "number" && raw.topSpeed > 0) {
    fields.max_speed_kmh = raw.topSpeed * MPS_TO_KMH;
  }
  if (typeof raw.movingTime === "number" && raw.movingTime > 0) {
    fields.moving_sec = Math.round(raw.movingTime / 1000);
  }
  if (typeof raw.duration === "number" && raw.duration > 0) {
    fields.elapsed_sec = Math.round(raw.duration / 1000);
  }
  if (typeof raw.totalElevationGain === "number" && raw.totalElevationGain > 0) {
    fields.elevation_gain_m = raw.totalElevationGain;
  }
  if (typeof raw.totalElevationLoss === "number" && raw.totalElevationLoss > 0) {
    fields.elevation_loss_m = raw.totalElevationLoss;
  }

  // Title. Prefer the user's own ride name when they set one ("Let's go sailing")
  // — that's their explicit, precious label. Otherwise Beeline has no title, so we
  // synthesize a Strava-style time-of-day name ("Morning ride"). Either way it's
  // the `title_base` (shown in bold); when the ride navigated to a place, the
  // reverse-geocoded destination is appended so the controller can render it as a
  // muted location suffix ("Let's go sailing, Strand IJburg").
  const userName = typeof raw.name === "string" ? raw.name.trim() : "";
  const base = userName || (zone ? timeOfDayNameFromHour(zone.hour) : timeOfDayName(raw.start));
  const place = destinationPlace(raw);
  fields.title_base = base;
  fields.title = place ? `${base}, ${place}` : base;

  // Route track: keep the FULL inline polyline. It's already compact and is the
  // only route data Beeline gives us, so we store it verbatim (no simplification)
  // and let the renderers sample it as needed.
  if (raw.polyline) {
    const pts = decodePolyline(raw.polyline);
    if (pts.length >= 2) {
      fields.track = raw.polyline;
      fields.track_src_points = pts.length;
      fields.track_points = pts.length;
      fields.track_km = trackLengthKm(pts);
    }
  }

  return { key, fields };
}
