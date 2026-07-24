// Unit tests for the standalone GPX relay Lambda (infra/gpx-relay/index.mjs).
//
// The handler reads its config from env vars at module load, so each test that
// needs a different config imports a fresh module instance via `loadHandler`
// (Vitest's `resetModules` re-evaluates it). The relay is plain JS outside the app
// build; a `@ts-expect-error` keeps `tsc` from type-checking it as part of `src`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: the relay is plain JS; events/results are untyped here.
type Handler = (event: any) => Promise<any>;

// In-memory fake for the DynamoDB persistence path. `store` deliberately PERSISTS across
// `loadHandler` (fresh module) calls so a test can prove a counter survives a simulated
// cold start; `reset()` clears it between tests. `setFail` makes every send() throw, to
// exercise the relay's fail-closed behaviour.
const ddbFake = vi.hoisted(() => {
  let failing = false;
  const store = new Map<string, number>();
  return {
    store,
    reset() {
      store.clear();
      failing = false;
    },
    setFail(v: boolean) {
      failing = v;
    },
    get failing() {
      return failing;
    },
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => {
  class UpdateItemCommand {
    __kind = "update";
    // biome-ignore lint/suspicious/noExplicitAny: minimal stand-ins for the SDK command/client.
    constructor(public input: any) {}
  }
  class GetItemCommand {
    __kind = "get";
    // biome-ignore lint/suspicious/noExplicitAny: minimal stand-ins for the SDK command/client.
    constructor(public input: any) {}
  }
  class DynamoDBClient {
    // biome-ignore lint/suspicious/noExplicitAny: unused client config in the fake.
    // biome-ignore lint/complexity/noUselessConstructor: needed to accept + ignore the SDK config arg.
    constructor(_config: any) {}
    // biome-ignore lint/suspicious/noExplicitAny: command/result are untyped in the fake.
    async send(cmd: any) {
      if (ddbFake.failing) throw new Error("ddb unavailable");
      const pk = cmd.input.Key.pk.S as string;
      if (cmd.__kind === "update") {
        // UpdateItem with ADD ... ReturnValues=UPDATED_NEW echoes the new value in `Attributes`.
        const next = (ddbFake.store.get(pk) ?? 0) + 1;
        ddbFake.store.set(pk, next);
        return { Attributes: { n: { N: String(next) } } };
      }
      // GetItem returns the row under `Item` (absent => no `Item`).
      const v = ddbFake.store.get(pk);
      return v === undefined ? {} : { Item: { n: { N: String(v) } } };
    }
  }
  return { DynamoDBClient, UpdateItemCommand, GetItemCommand };
});

const RELAY_ENV_KEYS = [
  "ENABLED",
  "ALLOWED_ORIGINS",
  "RL_PER_MIN",
  "RL_PER_DAY",
  "RL_GLOBAL_PER_MONTH",
  "MAX_BYTES",
  "DDB_TABLE",
];

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

  it("rejects an unsupported method", async () => {
    const handler = await loadHandler();
    const res = await handler({
      requestContext: { http: { method: "PUT" } },
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

  it("GET returns runtime stats (no auth) with CORS advertising GET", async () => {
    const handler = await loadHandler();
    const res = await handler({
      requestContext: { http: { method: "GET" } },
      headers: { origin: ORIGIN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe(ORIGIN);
    expect(res.headers["Access-Control-Allow-Methods"]).toContain("GET");
    const body = JSON.parse(res.body);
    expect(typeof body.startedAt).toBe("string");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof body.instanceId).toBe("string");
    expect(body.downloads).toBe(0);
    expect(body.monthlyDownloads).toBe(0);
    expect(body.monthlyLimit).toBe(10000);
    expect(body.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it("stats: a successful download increments downloads + monthlyDownloads", async () => {
    const handler = await loadHandler();
    mockHappyFetch();
    expect((await handler(postEvent({ rideId: "-Ride1" }))).statusCode).toBe(200);
    const res = await handler({ requestContext: { http: { method: "GET" } }, headers: {} });
    const body = JSON.parse(res.body);
    expect(body.downloads).toBe(1);
    expect(body.monthlyDownloads).toBe(1);
  });

  it("GET stats answer even when ENABLED=0 (diagnostic, not gated)", async () => {
    const handler = await loadHandler({ ENABLED: "0" });
    const res = await handler({ requestContext: { http: { method: "GET" } }, headers: {} });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).enabled).toBe(false);
  });

  it("global monthly cap: blocks past the limit with 429 + Retry-After, no egress", async () => {
    const handler = await loadHandler({ RL_GLOBAL_PER_MONTH: "1", RL_PER_MIN: "1000" });
    const fetchFn = mockHappyFetch();
    // First successful download consumes the only slot.
    expect((await handler(postEvent({ rideId: "-Ride1" }))).statusCode).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // Second is blocked globally — even from a different account/IP — before any hop.
    const blocked = await handler(
      postEvent({ rideId: "-Ride1" }, { uid: "u2", ip: "9.9.9.9" }),
    );
    expect(blocked.statusCode).toBe(429);
    expect(blocked.error ?? JSON.parse(blocked.body).error).toMatch(/monthly download limit/);
    expect(Number(blocked.headers["Retry-After"])).toBeGreaterThan(0);
    expect(fetchFn).toHaveBeenCalledTimes(2); // no new upstream calls
    // Stats reflect the cap.
    const stats = await handler({ requestContext: { http: { method: "GET" } }, headers: {} });
    expect(JSON.parse(stats.body).monthlyDownloads).toBe(1);
  });
});

describe("gpx-relay Lambda handler (DynamoDB persistence)", () => {
  const DDB = { DDB_TABLE: "relay-state" };
  // Pin time so the minute/day/month window keys are stable within (and across) loads.
  const FIXED = Date.UTC(2026, 5, 15, 12, 0, 0);

  beforeEach(() => {
    ddbFake.reset();
    vi.spyOn(Date, "now").mockReturnValue(FIXED);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("durable rate limit survives a container restart (fresh module load)", async () => {
    // RL_PER_MIN=2: two ok on the first container...
    const h1 = await loadHandler({ ...DDB, RL_PER_MIN: "2", RL_PER_DAY: "1000" });
    mockHappyFetch();
    expect((await h1(postEvent({ rideId: "-Ride1" }))).statusCode).toBe(200);
    expect((await h1(postEvent({ rideId: "-Ride1" }))).statusCode).toBe(200);
    // ...then a NEW container (its in-memory maps are empty) still sees the shared
    // DynamoDB count and blocks the 3rd request. This is the whole point of persistence.
    const h2 = await loadHandler({ ...DDB, RL_PER_MIN: "2", RL_PER_DAY: "1000" });
    const limited = await h2(postEvent({ rideId: "-Ride1" }));
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("durable monthly cap blocks past the limit before any egress", async () => {
    const h = await loadHandler({ ...DDB, RL_GLOBAL_PER_MONTH: "1", RL_PER_MIN: "1000" });
    const fetchFn = mockHappyFetch();
    expect((await h(postEvent({ rideId: "-Ride1" }))).statusCode).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // Even a different account is blocked globally, before any upstream hop.
    const blocked = await h(postEvent({ rideId: "-Ride1" }, { uid: "u2" }));
    expect(blocked.statusCode).toBe(429);
    expect(JSON.parse(blocked.body).error).toMatch(/monthly download limit/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("fails closed (503) when the store is unavailable — no upstream egress", async () => {
    const h = await loadHandler({ ...DDB });
    const fetchFn = mockHappyFetch();
    ddbFake.setFail(true);
    const res = await h(postEvent({ rideId: "-Ride1" }));
    expect(res.statusCode).toBe(503);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(Number(res.headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("GET reports durable counts from the store (persistence: dynamodb)", async () => {
    const h = await loadHandler({ ...DDB });
    mockHappyFetch();
    expect((await h(postEvent({ rideId: "-Ride1" }))).statusCode).toBe(200);
    const res = await h({ requestContext: { http: { method: "GET" } }, headers: {} });
    const body = JSON.parse(res.body);
    expect(body.persistence).toBe("dynamodb");
    expect(body.downloads).toBe(1); // durable lifetime, from the table
    expect(body.monthlyDownloads).toBe(1);
    expect(body.containerDownloads).toBe(1);
    expect(body.storeError).toBe(false);
  });

  it("GET flags storeError when the store read fails (still 200, diagnostic)", async () => {
    const h = await loadHandler({ ...DDB });
    ddbFake.setFail(true);
    const res = await h({ requestContext: { http: { method: "GET" } }, headers: {} });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.persistence).toBe("dynamodb");
    expect(body.storeError).toBe(true);
    expect(body.downloads).toBeNull();
  });
});
