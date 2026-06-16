// Unit tests for the standalone GPX relay Lambda (infra/gpx-relay/index.mjs).
//
// The handler reads its config from env vars at module load, so each test that
// needs a different config imports a fresh module instance via `loadHandler`
// (Vitest's `resetModules` re-evaluates it). The relay is plain JS outside the app
// build; a `@ts-expect-error` keeps `tsc` from type-checking it as part of `src`.

import { afterEach, describe, expect, it, vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: the relay is plain JS; events/results are untyped here.
type Handler = (event: any) => Promise<any>;

const RELAY_ENV_KEYS = ["ENABLED", "ALLOWED_ORIGINS", "RL_PER_MIN", "RL_PER_DAY", "MAX_BYTES"];

async function loadHandler(env: Record<string, string> = {}): Promise<Handler> {
  vi.resetModules();
  for (const k of RELAY_ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  // @ts-expect-error - plain-JS relay module, intentionally untyped for the app build.
  const mod = (await import("../infra/gpx-relay/index.mjs")) as { handler: Handler };
  return mod.handler;
}

const ORIGIN = "https://gubenkoved.github.io";

/** A fake Firebase id token whose (unverified) payload carries a uid for bucketing. */
function token(uid = "u1"): string {
  const payload = Buffer.from(JSON.stringify({ user_id: uid })).toString("base64url");
  return `h.${payload}.s`;
}

function postEvent(
  body: unknown,
  opts: { origin?: string; uid?: string; ip?: string } = {},
): unknown {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token(opts.uid ?? "u1")}`,
  };
  if (opts.origin !== undefined) headers.origin = opts.origin;
  else headers.origin = ORIGIN;
  return {
    requestContext: { http: { method: "POST", sourceIp: opts.ip ?? "1.2.3.4" } },
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

const GZ = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4]);

/** Mock global fetch: hop 1 (exportRide) → path, hop 2 (storage) → gz bytes. */
function mockHappyFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string) => {
    if (String(url).includes("/exportRide")) {
      return new Response(JSON.stringify({ result: "ride-gpx-export/u1/-Ride1.gpx.gz" }), {
        status: 200,
      });
    }
    return new Response(GZ, { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gpx-relay Lambda handler", () => {
  it("answers CORS preflight (OPTIONS) with 204 + ACAO", async () => {
    const handler = await loadHandler();
    const res = await handler({
      requestContext: { http: { method: "OPTIONS" } },
      headers: { origin: ORIGIN },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe(ORIGIN);
    expect(res.headers["Access-Control-Allow-Methods"]).toContain("POST");
  });

  it("relays both hops and returns the gzipped GPX (base64) with CORS", async () => {
    const handler = await loadHandler();
    const fetchFn = mockHappyFetch();
    const res = await handler(postEvent({ rideId: "-Ride1" }));

    expect(res.statusCode).toBe(200);
    expect(res.isBase64Encoded).toBe(true);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe(ORIGIN);
    expect(res.headers["Content-Type"]).toBe("application/gpx+xml");
    // The body is the gz bytes verbatim.
    expect([...Buffer.from(res.body, "base64")]).toEqual([...GZ]);

    // Hop 1 = exportRide with the bearer token; hop 2 = storage with Firebase auth.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [u1, o1] = fetchFn.mock.calls[0];
    expect(String(u1)).toContain("/exportRide");
    expect((o1 as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${token()}`,
    });
    const [u2, o2] = fetchFn.mock.calls[1];
    expect(String(u2)).toContain("firebasestorage.googleapis.com");
    expect(String(u2)).toContain("alt=media");
    expect((o2 as RequestInit).headers).toMatchObject({
      Authorization: `Firebase ${token()}`,
    });
  });

  it("rejects a non-POST method", async () => {
    const handler = await loadHandler();
    const res = await handler({
      requestContext: { http: { method: "GET" } },
      headers: { origin: ORIGIN },
    });
    expect(res.statusCode).toBe(405);
  });

  it("requires a bearer token", async () => {
    const handler = await loadHandler();
    mockHappyFetch();
    const ev = postEvent({ rideId: "-Ride1" }) as { headers: Record<string, string> };
    delete ev.headers.authorization;
    const res = await handler(ev);
    expect(res.statusCode).toBe(401);
  });

  it("validates the rideId (no path/URL injection)", async () => {
    const handler = await loadHandler();
    const fetchFn = mockHappyFetch();
    for (const bad of ["../secret", "a/b", "x".repeat(80), "", 42]) {
      const res = await handler(postEvent({ rideId: bad }));
      expect(res.statusCode).toBe(400);
    }
    // Never reached an upstream call with a bad id.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects an invalid JSON body", async () => {
    const handler = await loadHandler();
    const res = await handler(postEvent("{not json"));
    expect(res.statusCode).toBe(400);
  });

  it("maps a Beeline 'no ride points' to 422 (no recorded track)", async () => {
    const handler = await loadHandler();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("Unable to export ride due lack of ride points", {
            status: 404,
          }),
      ),
    );
    const res = await handler(postEvent({ rideId: "-Ride1" }));
    expect(res.statusCode).toBe(422);
  });

  it("kill switch: ENABLED=0 returns 503 without any upstream call", async () => {
    const handler = await loadHandler({ ENABLED: "0" });
    const fetchFn = mockHappyFetch();
    const res = await handler(postEvent({ rideId: "-Ride1" }));
    expect(res.statusCode).toBe(503);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("origin allow-list: refuses an origin not on the list", async () => {
    const handler = await loadHandler({ ALLOWED_ORIGINS: "https://allowed.example" });
    const fetchFn = mockHappyFetch();
    const res = await handler(
      postEvent({ rideId: "-Ride1" }, { origin: "https://evil.example" }),
    );
    expect(res.statusCode).toBe(403);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rate limit: the (N+1)th call from one account gets 429 + Retry-After", async () => {
    const handler = await loadHandler({ RL_PER_MIN: "2", RL_PER_DAY: "1000" });
    mockHappyFetch();
    expect((await handler(postEvent({ rideId: "-Ride1" }))).statusCode).toBe(200);
    expect((await handler(postEvent({ rideId: "-Ride1" }))).statusCode).toBe(200);
    const limited = await handler(postEvent({ rideId: "-Ride1" }));
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["Retry-After"])).toBeGreaterThan(0);
    // A different account is unaffected (separate bucket).
    expect((await handler(postEvent({ rideId: "-Ride1" }, { uid: "u2" }))).statusCode).toBe(
      200,
    );
  });
});
