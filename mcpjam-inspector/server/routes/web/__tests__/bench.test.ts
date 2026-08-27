import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The bench relay is the whole edge in front of `/internal/v1/bench/*`, and
 * four of its properties are the ones that break quietly:
 *
 *  - a backend that has not enabled benchmark runs yet degrades to a clean
 *    answer instead of a 500, which is what lets this merge first;
 *  - starting work is budgeted and CONTINUING it is not, so a poller cannot be
 *    locked out of the run they just paid for;
 *  - a result link opens with no session at all;
 *  - the service token never goes out over cleartext.
 */

const listAllToolsMock = vi.fn();

vi.mock("@mcpjam/sdk/operations", () => ({
  listAllTools: (...args: unknown[]) => listAllToolsMock(...args),
}));

/**
 * `runEphemeralConnection` normally authorizes the caller against the backend
 * and dials the saved server. Replaced with a miniature (parse → run → return)
 * so these assertions are about THIS file rather than the shared connect
 * plumbing, which has its own tests. It re-parses the body it is HANDED, which
 * is how the "no caller-supplied credentials" assertion below has teeth.
 */
vi.mock("../auth.js", () => ({
  runEphemeralConnection: async (
    _c: unknown,
    rawBody: Record<string, unknown>,
    schema: { parse: (value: unknown) => unknown },
    fn: (manager: unknown, body: unknown) => Promise<unknown>,
  ) => {
    connectBodies.push(rawBody);
    return fn({ __manager: true }, schema.parse(rawBody));
  },
}));

const connectBodies: Array<Record<string, unknown>> = [];

/**
 * Fresh module per test: the rate-limit and result-cache maps are module
 * state. `errors` is re-imported from the SAME reset registry — a
 * `WebRouteError` thrown by the freshly-loaded route is not an instance of a
 * stale registry's class, and every status would flatten to 500.
 */
async function freshApp() {
  vi.resetModules();
  const [{ default: benchRoutes }, { mapRuntimeError, webError }] =
    await Promise.all([import("../bench"), import("../errors")]);

  const app = new Hono();
  app.route("/api/web/bench", benchRoutes);
  app.onError((error, c) => {
    const routeError = mapRuntimeError(error);
    return webError(c, routeError.status, routeError.code, routeError.message);
  });
  return app;
}

const AUTHED = {
  "content-type": "application/json",
  authorization: "Bearer caller-token",
};

/** Params are declared so `mock.calls[n]` stays typed at the assert sites. */
function jsonOk(payload: Record<string, unknown>) {
  return vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ ok: true, ...payload }, { status: 200 }),
  );
}

/**
 * The classification call. `/preflight` asks the backend twice — once to learn
 * whether the family is deployed at all, then once for real — and only the
 * second carries a snapshot, which is what tells them apart.
 */
function classifyCall(
  fetchMock: ReturnType<typeof jsonOk>,
): [string, RequestInit] {
  const call = fetchMock.mock.calls.find(
    ([, init]) =>
      typeof init?.body === "string" && init.body.includes("toolSnapshot"),
  );
  if (!call) throw new Error("the backend was never asked to classify");
  return call as [string, RequestInit];
}

function postPreflight(app: Hono, body: Record<string, unknown> = {}) {
  return app.request("/api/web/bench/preflight", {
    method: "POST",
    headers: AUTHED,
    body: JSON.stringify({
      projectId: "proj_1",
      serverId: "srv_1",
      ...body,
    }),
  });
}

function startRun(app: Hono, headers: Record<string, string> = {}) {
  return app.request("/api/web/bench/runs", {
    method: "POST",
    headers: { ...AUTHED, ...headers },
    body: JSON.stringify({
      projectId: "proj_1",
      serverId: "srv_1",
      receiptId: "rcpt_1",
    }),
  });
}

const originalFetch = global.fetch;
const originalConvexUrl = process.env.CONVEX_HTTP_URL;
const originalServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;
const originalPepper = process.env.GUEST_SESSION_HASH_PEPPER;

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://convex.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "svc-tok";
  // Pinned so the spend-key hash is deterministic and no local secret file is
  // written as a side effect of running the suite.
  process.env.GUEST_SESSION_HASH_PEPPER = "test-pepper";
  connectBodies.length = 0;
  listAllToolsMock.mockResolvedValue({
    tools: [
      {
        name: "search",
        description: "Search the corpus",
        inputSchema: { type: "object" },
      },
    ],
    toolsMetadata: {},
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const [key, value] of [
    ["CONVEX_HTTP_URL", originalConvexUrl],
    ["INSPECTOR_SERVICE_TOKEN", originalServiceToken],
    ["GUEST_SESSION_HASH_PEPPER", originalPepper],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe("POST /api/web/bench/preflight", () => {
  it("carries both tokens and the attested spend key to the backend", async () => {
    const fetchMock = jsonOk({ receiptId: "rcpt_1", categories: [] });
    global.fetch = fetchMock as any;

    const app = await freshApp();
    const res = await app.request("/api/web/bench/preflight", {
      method: "POST",
      // cf-connecting-ip, because Cloudflare rewrites it on every hop — a
      // header the caller could have written is covered by the next test.
      headers: { ...AUTHED, "cf-connecting-ip": "203.0.113.4" },
      body: JSON.stringify({ projectId: "proj_1", serverId: "srv_1" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).receiptId).toBe("rcpt_1");

    const [url, init] = classifyCall(fetchMock);
    expect(url).toBe("https://convex.test/internal/v1/bench/preflight");
    const headers = init.headers as Record<string, string>;
    // The service token says "this is the inspector"; the caller bearer says
    // "on behalf of this user". Neither substitutes for the other.
    expect(headers["x-inspector-service-token"]).toBe("svc-tok");
    expect(headers.authorization).toBe("Bearer caller-token");
    // Hashed here, so the raw address never reaches Convex.
    expect(headers["x-mcpjam-guest-ip-hash"]).toEqual(expect.any(String));
    expect(headers["x-mcpjam-guest-ip-hash"]).not.toContain("203.0.113.4");
  });

  // The spend key is the ONLY thing standing between a guest who clears their
  // cookie and an unlimited number of free benchmark runs. We send the backend
  // an HMAC and never the address, so it has nothing left to re-validate — if
  // a caller can choose the address we hash, the caller can mint buckets and
  // the daily cap is decorative.
  it.each([
    ["x-forwarded-for", "198.51.100.9"],
    ["x-real-ip", "198.51.100.9"],
  ])("sends no spend key when the address is only claimed via %s", async (
    header,
    value,
  ) => {
    const fetchMock = jsonOk({ receiptId: "rcpt_1", categories: [] });
    global.fetch = fetchMock as any;

    const app = await freshApp();
    const res = await app.request("/api/web/bench/preflight", {
      method: "POST",
      headers: { ...AUTHED, [header]: value },
      body: JSON.stringify({ projectId: "proj_1", serverId: "srv_1" }),
    });

    expect(res.status).toBe(200);
    const headers = classifyCall(fetchMock)[1].headers as Record<
      string,
      string
    >;
    // Absent, NOT a shared placeholder: the backend buckets daily runs on this
    // key, so pooling every unattested guest under one value would let the
    // first of them spend the whole deployment's allowance. Absent falls back
    // to the backend's cookie-only bucket.
    expect(headers["x-mcpjam-guest-ip-hash"]).toBeUndefined();
  });

  it("prefers the attested address when a spoofed header sits beside it", async () => {
    const fetchMock = jsonOk({ receiptId: "rcpt_1", categories: [] });
    global.fetch = fetchMock as any;

    const app = await freshApp();
    const attested = await app.request("/api/web/bench/preflight", {
      method: "POST",
      headers: { ...AUTHED, "cf-connecting-ip": "203.0.113.4" },
      body: JSON.stringify({ projectId: "proj_1", serverId: "srv_1" }),
    });
    expect(attested.status).toBe(200);
    const alone = (classifyCall(fetchMock)[1].headers as Record<string, string>)[
      "x-mcpjam-guest-ip-hash"
    ];

    const fetchMock2 = jsonOk({ receiptId: "rcpt_1", categories: [] });
    global.fetch = fetchMock2 as any;
    const app2 = await freshApp();
    const spoofed = await app2.request("/api/web/bench/preflight", {
      method: "POST",
      headers: {
        ...AUTHED,
        "cf-connecting-ip": "203.0.113.4",
        "x-forwarded-for": "198.51.100.9",
        "x-real-ip": "198.51.100.9",
      },
      body: JSON.stringify({ projectId: "proj_1", serverId: "srv_1" }),
    });
    expect(spoofed.status).toBe(200);
    const alongside = (
      classifyCall(fetchMock2)[1].headers as Record<string, string>
    )["x-mcpjam-guest-ip-hash"];

    // Same bucket either way: adding headers you control must not move you to
    // a fresh one.
    expect(alongside).toBe(alone);
  });

  it("relays the captured tool snapshot", async () => {
    const fetchMock = jsonOk({ receiptId: "rcpt_1" });
    global.fetch = fetchMock as any;

    const app = await freshApp();
    const res = await postPreflight(app);

    expect(res.status).toBe(200);
    expect((await res.json()).toolCount).toBe(1);

    const [, init] = classifyCall(fetchMock);
    const sent = JSON.parse(init.body as string);
    expect(sent.projectId).toBe("proj_1");
    expect(sent.toolSnapshot.tools).toEqual([
      {
        name: "search",
        description: "Search the corpus",
        inputSchema: { type: "object" },
      },
    ]);
    // Live surface, not a cached serve: a benchmark is scored against what the
    // server answers now.
    expect(listAllToolsMock).toHaveBeenCalledWith(expect.anything(), {
      serverId: "srv_1",
      cacheMode: "bypass",
    });
  });

  it("never forwards caller-supplied credentials into the connection", async () => {
    // The entire point of naming a SAVED server: the connection is
    // credentialed from the project's stored config, so a caller cannot attach
    // a token they were never granted.
    global.fetch = jsonOk({ receiptId: "rcpt_1" }) as any;

    const app = await freshApp();
    const res = await postPreflight(app, {
      oauthAccessToken: "attacker-token",
      headers: { authorization: "Bearer attacker-token" },
      url: "https://evil.example.com/mcp",
    });

    expect(res.status).toBe(200);
    expect(connectBodies).toEqual([{ projectId: "proj_1", serverId: "srv_1" }]);
  });

  it("drops server-controlled `_meta` and stops at the tool cap", async () => {
    listAllToolsMock.mockResolvedValue({
      tools: Array.from({ length: 501 }, (_, i) => ({
        name: `tool_${i}`,
        _meta: { secret: "do-not-persist" },
      })),
      toolsMetadata: {},
    });
    const fetchMock = jsonOk({ receiptId: "rcpt_1" });
    global.fetch = fetchMock as any;

    const app = await freshApp();
    const res = await postPreflight(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      toolCount: 500,
      toolSnapshotTruncated: true,
    });
    const [, init] = classifyCall(fetchMock);
    expect(init.body as string).not.toContain("do-not-persist");
  });

  it("measures the snapshot cap in UTF-8 bytes, not UTF-16 units", async () => {
    // 200k CJK characters: 200k UTF-16 code units, comfortably under the 512
    // KiB cap by the old measure — and 600 KB on the wire, comfortably over it
    // by the honest one. The bound calls itself bytes, so it has to count them.
    listAllToolsMock.mockResolvedValue({
      tools: [
        { name: "ascii", description: "small" },
        { name: "cjk", description: "文".repeat(200_000) },
      ],
      toolsMetadata: {},
    });
    const fetchMock = jsonOk({ receiptId: "rcpt_1" });
    global.fetch = fetchMock as any;

    const app = await freshApp();
    const res = await postPreflight(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      toolCount: 1,
      toolSnapshotTruncated: true,
    });
    const [, init] = classifyCall(fetchMock);
    expect(Buffer.byteLength(init.body as string, "utf8")).toBeLessThan(
      512 * 1024,
    );
  });

  it("400s a body with no serverId without dialing anything", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    const app = await freshApp();
    const res = await app.request("/api/web/bench/preflight", {
      method: "POST",
      headers: AUTHED,
      body: JSON.stringify({ projectId: "proj_1" }),
    });

    expect(res.status).toBe(400);
    expect(listAllToolsMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401s without a bearer", async () => {
    const app = await freshApp();
    const res = await app.request("/api/web/bench/preflight", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "proj_1", serverId: "srv_1" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("a backend that has not enabled benchmark runs", () => {
  /**
   * The backend halves land after this router does, so until the flag flips
   * every one of these paths answers 404 — a bare Convex routing 404, with no
   * envelope of ours in it. None of them may surface as a 500.
   */
  it("turns every 404 into a clean not-enabled answer", async () => {
    global.fetch = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    ) as any;

    const app = await freshApp();
    const calls: Array<[string, RequestInit | undefined]> = [
      [
        "/api/web/bench/preflight",
        {
          method: "POST",
          headers: AUTHED,
          body: JSON.stringify({ projectId: "p", serverId: "s" }),
        },
      ],
      [
        "/api/web/bench/quotes",
        {
          method: "POST",
          headers: AUTHED,
          body: JSON.stringify({ projectId: "p", serverId: "s" }),
        },
      ],
      [
        "/api/web/bench/runs",
        {
          method: "POST",
          headers: AUTHED,
          body: JSON.stringify({
            projectId: "p",
            serverId: "s",
            receiptId: "r",
          }),
        },
      ],
      ["/api/web/bench/runs/run_1", { headers: AUTHED }],
      ["/api/web/bench/runs/run_1/cancel", { method: "POST", headers: AUTHED }],
      ["/api/web/bench/results/sec_1", undefined],
    ];

    for (const [path, init] of calls) {
      const res = await app.request(path, init);
      const body = await res.json();
      expect(res.status, path).toBe(503);
      expect(body.code, path).toBe("FEATURE_NOT_SUPPORTED");
      expect(body.message, path).toMatch(/not enabled/i);
    }

    // And `/preflight` never opened the caller's server to find that out. The
    // capability probe answers first, so a disabled deployment costs the target
    // nothing — no dial, no OAuth, no `tools/list`.
    expect(listAllToolsMock).not.toHaveBeenCalled();
  });

  it("probes before dialing, so a down target cannot mask the real answer", async () => {
    // The second failure mode of dialing first: the connection fails on its own
    // merits and the caller is shown the TARGET's error for a feature that was
    // never on. The probe has to land before `runEphemeralConnection` for this
    // to come back as FEATURE_NOT_SUPPORTED.
    global.fetch = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    ) as any;
    listAllToolsMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const app = await freshApp();
    const res = await postPreflight(app);

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("FEATURE_NOT_SUPPORTED");
    expect(connectBodies).toEqual([]);
  });

  it("lets a deployed backend through on any answer that is not a bare 404", async () => {
    // The probe may only ever short-circuit the disabled case. A backend that
    // rejects the probe body on shape has PROVED the route exists, so preflight
    // must proceed rather than reading the rejection as "not enabled".
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      JSON.parse(init.body as string).probe
        ? Response.json(
            { ok: false, error: "projectId required" },
            { status: 400 },
          )
        : Response.json({ ok: true, receiptId: "rcpt_1" }, { status: 200 }),
    );
    global.fetch = fetchMock as any;

    const app = await freshApp();
    const res = await postPreflight(app);

    expect(res.status).toBe(200);
    expect((await res.json()).receiptId).toBe("rcpt_1");
    expect(listAllToolsMock).toHaveBeenCalled();
  });

  it("still reports a genuinely missing run as a 404", async () => {
    // A deployed route says "this entity is gone" with its own envelope; that
    // must not collapse into the not-enabled answer.
    global.fetch = vi.fn(async () =>
      Response.json({ ok: false, error: "Not found" }, { status: 404 }),
    ) as any;

    const app = await freshApp();
    const res = await app.request("/api/web/bench/runs/run_gone", {
      headers: AUTHED,
    });

    expect(res.status).toBe(404);
    expect((await res.json()).message).toMatch(/no longer exists/);
  });

  it("still reports an unknown result link as a 404", async () => {
    global.fetch = vi.fn(async () =>
      Response.json({ ok: false, error: "Not found" }, { status: 404 }),
    ) as any;

    const app = await freshApp();
    const res = await app.request("/api/web/bench/results/nope");

    expect(res.status).toBe(404);
    expect((await res.json()).message).toMatch(/not valid/);
  });
});

describe("per-IP start-work budget", () => {
  it("429s a caller who keeps starting runs", async () => {
    global.fetch = jsonOk({ runId: "run_1" }) as any;

    const app = await freshApp();
    for (let i = 0; i < 30; i++) {
      expect(
        (await startRun(app, { "cf-connecting-ip": "198.51.100.7" })).status,
      ).toBe(200);
    }
    expect(
      (await startRun(app, { "cf-connecting-ip": "198.51.100.7" })).status,
    ).toBe(429);
  });

  /**
   * The failure this exists to prevent: a caller spends the last slot starting
   * a run, then cannot poll or cancel the run they just paid for.
   */
  it("never debits a continuation, so an exhausted caller can still finish", async () => {
    global.fetch = jsonOk({ runId: "run_1", status: "running" }) as any;

    const app = await freshApp();
    const ip = { "cf-connecting-ip": "198.51.100.8" };
    for (let i = 0; i < 30; i++) {
      expect((await startRun(app, ip)).status).toBe(200);
    }
    expect((await startRun(app, ip)).status).toBe(429);

    const poll = await app.request("/api/web/bench/runs/run_1", {
      headers: { ...AUTHED, ...ip },
    });
    expect(poll.status).toBe(200);

    const cancel = await app.request("/api/web/bench/runs/run_1/cancel", {
      method: "POST",
      headers: { ...AUTHED, ...ip },
    });
    expect(cancel.status).toBe(200);

    // And polling all day does not quietly refill or drain anything: the start
    // budget is still spent.
    for (let i = 0; i < 40; i++) {
      await app.request("/api/web/bench/runs/run_1", {
        headers: { ...AUTHED, ...ip },
      });
    }
    expect((await startRun(app, ip)).status).toBe(429);
  });

  /**
   * The lockout this exists to prevent: a forwarding header is caller-written,
   * so keying a window per VALUE lets one actor mint entries until the map is
   * full — after which the limiter fails closed on every new key and refuses
   * everyone who arrives next. Unplaceable requests share one bucket instead,
   * so the table only ever grows with addresses the deployment can vouch for.
   */
  it("cannot be locked out by a caller rotating forwarding headers", async () => {
    global.fetch = jsonOk({ runId: "run_1" }) as any;

    const app = await freshApp();
    const { BENCH_WINDOW_MAX_ENTRIES } = await import("../bench");

    // Past the map cap, which is the point at which the old keying started
    // refusing strangers.
    for (let i = 0; i <= BENCH_WINDOW_MAX_ENTRIES; i++) {
      await startRun(app, {
        "x-forwarded-for": `198.51.${Math.floor(i / 256) % 256}.${i % 256}`,
      });
    }

    // A caller the edge CAN place is untouched by any of it.
    expect(
      (await startRun(app, { "cf-connecting-ip": "203.0.113.42" })).status,
    ).toBe(200);
  });

  it("gives an unattested caller a shared bucket, not one per header value", async () => {
    global.fetch = jsonOk({ runId: "run_1" }) as any;

    const app = await freshApp();
    const { benchStartWorkWindowCountForTests } = await import("../bench");

    for (let i = 0; i < 200; i++) {
      await startRun(app, { "x-forwarded-for": `198.51.100.${i % 256}` });
    }

    // One entry for the whole pool. Rotating the header buys a seat in the
    // busiest bucket, never a fresh allowance and never a new table row.
    expect(benchStartWorkWindowCountForTests()).toBe(1);
  });

  it("keeps each address on its own budget", async () => {
    global.fetch = jsonOk({ runId: "run_1" }) as any;

    const app = await freshApp();
    for (let i = 0; i < 30; i++) {
      await startRun(app, { "cf-connecting-ip": "198.51.100.1" });
    }
    expect(
      (await startRun(app, { "cf-connecting-ip": "198.51.100.1" })).status,
    ).toBe(429);
    expect(
      (await startRun(app, { "cf-connecting-ip": "198.51.100.2" })).status,
    ).toBe(200);
  });
});

describe("POST /api/web/bench/runs preferences", () => {
  /**
   * `preferences` is forwarded verbatim and the backend may persist it against
   * the run and price from it, so "the 1 MB body cap will catch it" is not a
   * bound. Each of these passes that cap and must still be refused here.
   */
  function runWith(app: Hono, preferences: Record<string, unknown>) {
    return app.request("/api/web/bench/runs", {
      method: "POST",
      headers: AUTHED,
      body: JSON.stringify({
        projectId: "proj_1",
        serverId: "srv_1",
        receiptId: "rcpt_1",
        preferences,
      }),
    });
  }

  it.each([
    [
      "too many keys",
      () =>
        Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 1])),
    ],
    ["an overlong key", () => ({ ["k".repeat(129)]: 1 })],
    [
      "nesting past the depth cap",
      () => {
        let nested: unknown = "leaf";
        for (let i = 0; i < 12; i++) nested = { nested };
        return { deep: nested } as Record<string, unknown>;
      },
    ],
    ["more than 8 KiB of JSON", () => ({ blob: "x".repeat(9 * 1024) })],
  ])("rejects %s before it reaches the backend", async (_label, build) => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    const app = await freshApp();
    const res = await runWith(app, build());

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still relays prefill of an ordinary size", async () => {
    const fetchMock = jsonOk({ runId: "run_1" });
    global.fetch = fetchMock as any;

    const app = await freshApp();
    const res = await runWith(app, { actor_gpt: { temperature: 0.2 } });

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).preferences).toEqual({
      actor_gpt: { temperature: 0.2 },
    });
  });
});

describe("GET /api/web/bench/results/:secret", () => {
  it("opens with no session, cookie, or bearer of any kind", async () => {
    const fetchMock = jsonOk({ result: { runId: "run_1", score: 71 } });
    global.fetch = fetchMock as any;

    const app = await freshApp();
    // No Authorization header, no Cookie — an incognito visitor.
    const res = await app.request("/api/web/bench/results/sec_abc");

    expect(res.status).toBe(200);
    expect((await res.json()).result.score).toBe(71);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://convex.test/internal/v1/bench/results/get");
    const headers = init.headers as Record<string, string>;
    // Nothing to forward on behalf of — the secret IS the credential, and it
    // travels in the body rather than a query string that would land in logs.
    expect(headers.authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ secret: "sec_abc" });
  });

  it("caches a repeat read instead of re-hitting the backend", async () => {
    const fetchMock = jsonOk({ result: { runId: "run_1" } });
    global.fetch = fetchMock as any;

    const app = await freshApp();
    await app.request("/api/web/bench/results/sec_abc");
    await app.request("/api/web/bench/results/sec_abc");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("charges only cache MISSES, and 429s a secret guesser", async () => {
    global.fetch = vi.fn(async () =>
      Response.json({ ok: false, error: "Not found" }, { status: 404 }),
    ) as any;

    const app = await freshApp();
    const guess = (n: number) =>
      app.request(`/api/web/bench/results/guess-${n}`, {
        headers: { "cf-connecting-ip": "203.0.113.77" },
      });

    for (let i = 0; i < 60; i++) {
      expect((await guess(i)).status).toBe(404);
    }
    expect((await guess(999)).status).toBe(429);
  });
});

describe("egress hardening", () => {
  it("refuses to send the service token to a cleartext backend", async () => {
    process.env.CONVEX_HTTP_URL = "http://convex.test";
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    const app = await freshApp();
    const res = await postPreflight(app);

    expect(res.status).toBe(503);
    expect((await res.json()).message).toMatch(/cleartext/);
    // And the refusal lands BEFORE the caller's own server is dialed.
    expect(listAllToolsMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows http on loopback, which is how local dev runs Convex", async () => {
    process.env.CONVEX_HTTP_URL = "http://127.0.0.1:3210";
    global.fetch = jsonOk({ receiptId: "rcpt_1" }) as any;

    const app = await freshApp();
    expect((await postPreflight(app)).status).toBe(200);
  });

  it("refuses a scheme that is neither https nor loopback http", async () => {
    process.env.CONVEX_HTTP_URL = "ftp://localhost";
    global.fetch = vi.fn();

    const app = await freshApp();
    expect((await postPreflight(app)).status).toBe(503);
  });

  it("503s when the service token is missing rather than calling out unauthenticated", async () => {
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    const app = await freshApp();
    expect((await postPreflight(app)).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a redirect rather than replaying the tokens to another host", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.test/" },
        }),
    ) as any;

    const app = await freshApp();
    const res = await app.request("/api/web/bench/quotes", {
      method: "POST",
      headers: AUTHED,
      body: JSON.stringify({ projectId: "p", serverId: "s" }),
    });

    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/redirected/);
  });

  it("502s when the backend is unreachable", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;

    const app = await freshApp();
    const res = await app.request("/api/web/bench/runs/run_1", {
      headers: AUTHED,
    });
    expect(res.status).toBe(502);
  });
});

describe("backend verdict passthrough", () => {
  it.each([
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHORIZED"],
    [402, "BILLING_LIMIT_REACHED"],
    [403, "FORBIDDEN"],
    [409, "CONFLICT"],
    [429, "RATE_LIMITED"],
  ])("keeps a %i verdict as %s", async (status, code) => {
    global.fetch = vi.fn(async () =>
      Response.json({ ok: false, error: "backend says no" }, { status }),
    ) as any;

    const app = await freshApp();
    const res = await app.request("/api/web/bench/quotes", {
      method: "POST",
      headers: AUTHED,
      body: JSON.stringify({ projectId: "p", serverId: "s" }),
    });

    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.code).toBe(code);
    expect(body.message).toBe("backend says no");
  });

  it("502s a 200 that is not the ok envelope", async () => {
    global.fetch = vi.fn(async () =>
      Response.json({ categories: [] }, { status: 200 }),
    ) as any;

    const app = await freshApp();
    const res = await app.request("/api/web/bench/quotes", {
      method: "POST",
      headers: AUTHED,
      body: JSON.stringify({ projectId: "p", serverId: "s" }),
    });

    expect(res.status).toBe(502);
  });
});
