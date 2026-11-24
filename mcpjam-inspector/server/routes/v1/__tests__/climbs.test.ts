/**
 * The climb routes that start and read a climb. Convex is mocked at
 * `convex/browser`, the real server at `runEphemeralConnection`, and the
 * grouped launch at the self-dispatch seam, so these prove the gateway: what it
 * checks before it launches, what it launches, and how each backend refusal is
 * answered. The backend's own rules (tiers, the flag, the split) are covered in
 * the backend's tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";

const mocks = vi.hoisted(() => ({ guest: vi.fn(), query: vi.fn(), mutation: vi.fn(), draining: false }));

vi.mock("../../../services/lifecycle/drain.js", async () => {
  const actual = await vi.importActual<typeof import("../../../services/lifecycle/drain.js")>("../../../services/lifecycle/drain.js");
  return { ...actual, serverDrain: { ...actual.createDrainCoordinator(), isDraining: () => mocks.draining } };
});
vi.mock("../../../services/guest-token.js", () => ({ validateGuestTokenDetailedAsync: mocks.guest }));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return { setAuth: vi.fn(), query: mocks.query, mutation: mocks.mutation };
  }),
}));
vi.mock("../../web/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../web/auth.js")>("../../web/auth.js");
  return {
    ...actual,
    runEphemeralConnection: async (_c: unknown, rawBody: Record<string, unknown>, schema: { parse(v: unknown): { serverId: string } }, fn: (m: unknown, b: { serverId: string }, r: object) => Promise<unknown>) => {
      const body = schema.parse(rawBody);
      return fn({ listTools: async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }) }, body, {});
    },
  };
});

import v1Routes from "../index.js";
import { registerSelfFetch } from "../../../utils/self-app.js";
import { runGroupIdFor } from "../../../services/climbs/run-group-id.js";

const PROJECT = "p1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUITE = "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx";
const CLIMB = "climb1xxxxxxxxxxxxxxxxxxxxxxxxxx";
const CLIMBS = `/api/v1/projects/${PROJECT}/climbs`;

type Handler = (args: Record<string, any>) => unknown;
let queries: Record<string, Handler>;
let mutations: Record<string, Handler>;
let launches: Array<{ path: string; method: string; body: any; headers: Headers }>;

const nameOf = (value: unknown) => getFunctionName(value as never);
const calls = (mock: typeof mocks.mutation, name: string) =>
  mock.mock.calls.filter(([fn]) => nameOf(fn) === name).map(([, args]) => args);

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app.request(`https://inspector.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer tok", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const climbRow = (over: Record<string, unknown> = {}) => ({
  climbId: CLIMB,
  suiteId: SUITE,
  projectId: PROJECT,
  serverId: "s_real",
  serverName: "Echo",
  environmentIds: ["env_a", "env_b"],
  state: "baselining",
  groups: { steering: 6, validation: 3, confirmation: 3 },
  ...over,
});
const group = (role: string) => {
  const idempotencyKey = `climb:${CLIMB}:baseline:1:${role}`;
  return {
    role,
    runGroupId: runGroupIdFor(SUITE, idempotencyKey),
    idempotencyKey,
    deadlineAt: 9,
    serverId: "s_mock",
    serverVersion: "1",
    environmentIds: ["env_a", "env_b"],
    caseIds: ["case_1"],
    status: "registered",
  };
};
const refusal = (code: string, message: string, extra: object = {}) => new ConvexError({ code, message, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://convex.example.com");
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex-http.example.com");
  mocks.guest.mockResolvedValue({ valid: false });
  launches = [];
  registerSelfFetch(async (req) => {
    const body = req.method === "POST" ? await req.clone().json() : undefined;
    launches.push({ path: new URL(req.url).pathname, method: req.method, body, headers: req.headers });
    if (req.url.includes("/eval-run-groups")) {
      const targets = body.targets.map((t: any) => ({
        status: "started",
        target: t,
        runId: `${body.idempotencyKey}:${t.environmentId}`,
        runStatus: "running",
      }));
      return Response.json(
        { runGroupId: runGroupIdFor(body.suiteId, body.idempotencyKey), suiteId: body.suiteId, outcome: "started", startedCount: 2, failedCount: 0, targets },
        { status: 202 },
      );
    }
    return Response.json({}, { status: 200 });
  });
  queries = {
    "climbs:getClimb": () => climbRow({ activeUnitKey: "baseline:1" }),
    "testSuites:estimateSuiteRunCredits": () => ({ credits: 40, lowerBoundCredits: 30 }),
  };
  mutations = {
    "climbs:startClimb": () => climbRow(),
    "mockServers:createMock": () => ({ mockId: "s_mock", version: 1, contentHash: "h" }),
    "climbs:beginClimbBaseline": () => ({ unitKey: "baseline:1", estimatedCredits: 60, groups: [group("baseline_a"), group("baseline_b")] }),
    "climbSettle:recordClimbRunLaunch": () => ({}),
    "climbRounds:stopClimb": () => ({ state: "stopped" }),
  };
  mocks.query.mockImplementation(async (fn, args) => {
    const handler = queries[nameOf(fn)];
    if (!handler) throw new Error(`unexpected query ${nameOf(fn)}`);
    return handler(args);
  });
  mocks.mutation.mockImplementation(async (fn, args) => {
    const handler = mutations[nameOf(fn)];
    if (!handler) throw new Error(`unexpected mutation ${nameOf(fn)}`);
    return handler(args);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const startBody = { suiteId: SUITE, serverId: "s_real", roundLimit: 3, creditLimit: 500 };

describe("POST /projects/:projectId/climbs", () => {
  it("starts the climb and launches the baseline as two grouped launches through the self-dispatch", async () => {
    const res = await request("POST", CLIMBS, startBody, {
      "x-mcpjam-launcher": JSON.stringify({ kind: "cli", client: "mcpjam-cli" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.climbId).toBe(CLIMB);
    expect(body.launch.unitKey).toBe("baseline:1");
    expect(body.launch.groups).toHaveLength(2);
    expect(body.launch.groups[0].runs).toHaveLength(2);

    expect(launches.map((l) => l.path)).toEqual([
      `/api/v1/projects/${PROJECT}/eval-run-groups`,
      `/api/v1/projects/${PROJECT}/eval-run-groups`,
    ]);
    expect(launches[0]!.body).toMatchObject({
      suiteId: SUITE,
      climbId: CLIMB,
      caseIds: ["case_1"],
      targets: [{ environmentId: "env_a" }, { environmentId: "env_b" }],
      serverReplacements: [
        { serverName: "Echo", replacementServerId: "s_mock", replacementVersion: "1", realListingHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ],
    });
    // The launch carries the caller's own label, as any launch from that client does.
    expect(JSON.parse(launches[0]!.headers.get("x-mcpjam-launcher")!)).toMatchObject({ kind: "cli" });
    expect(calls(mocks.mutation, "climbs:beginClimbBaseline")[0]).toMatchObject({
      serverId: "s_mock",
      estimatedCreditsPerGroup: 30,
    });
  });

  it.each([
    ["no round limit", { suiteId: SUITE, serverId: "s_real", creditLimit: 5 }],
    ["no credit limit", { suiteId: SUITE, serverId: "s_real", roundLimit: 2 }],
    ["sizes and lists together", { ...startBody, groupSizes: { steering: 1 }, groupLists: { steering: ["a"] } }],
    ["an unknown field", { ...startBody, picker: "agent", rounds: 4 }],
  ])("refuses %s before anything is made", async (_label, body) => {
    const res = await request("POST", CLIMBS, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("VALIDATION_ERROR");
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(launches).toEqual([]);
  });

  it("answers the backend's refusal by its code, with nothing made and nothing launched", async () => {
    mutations["climbs:startClimb"] = () => {
      throw refusal("CLIMB_ENVIRONMENT_LACKS_SERVER", 'The environment "Staging" does not include Echo. Add it, or leave that environment out.');
    };
    const res = await request("POST", CLIMBS, startBody);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining('"Staging"'),
      details: { code: "CLIMB_ENVIRONMENT_LACKS_SERVER" },
    });
    expect(calls(mocks.mutation, "mockServers:createMock")).toEqual([]);
    expect(launches).toEqual([]);
  });

  it("answers FEATURE_UNAVAILABLE, with the flag off, as every other gated route does", async () => {
    mutations["climbs:startClimb"] = () => {
      throw refusal("FEATURE_UNAVAILABLE", "Climbs are not available to this organization.", { feature: "climbs" });
    };
    const res = await request("POST", CLIMBS, startBody);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ details: { code: "FEATURE_UNAVAILABLE", feature: "climbs" } });
  });

  it("answers a caller below the edit tier with the backend's refusal", async () => {
    mutations["climbs:startClimb"] = () => {
      throw new ConvexError({ kind: "forbidden", code: "FORBIDDEN", message: "Your role cannot start climbs on this suite." });
    };
    const res = await request("POST", CLIMBS, startBody);
    expect([403, 404]).toContain(res.status);
    expect(launches).toEqual([]);
  });

  it("answers 429 and launches nothing while the server drains", async () => {
    mocks.draining = true;
    try {
      const res = await request("POST", CLIMBS, startBody);
      expect(res.status).toBe(429);
      expect(mocks.mutation).not.toHaveBeenCalled();
    } finally {
      mocks.draining = false;
    }
  });

  it("refuses a guest", async () => {
    mocks.guest.mockResolvedValue({ valid: true, guestId: "g1" });
    const res = await request("POST", CLIMBS, startBody);
    expect(res.status).toBe(401);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});

describe("GET and PATCH a climb", () => {
  it("reads a climb of the path's project", async () => {
    const res = await request("GET", `${CLIMBS}/${CLIMB}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ climbId: CLIMB, state: "baselining" });
  });

  it("does not find a climb that belongs to another project", async () => {
    queries["climbs:getClimb"] = () => climbRow({ projectId: "other" });
    const res = await request("GET", `${CLIMBS}/${CLIMB}`);
    expect(res.status).toBe(404);
  });

  it("answers a climb the backend does not know as not found", async () => {
    queries["climbs:getClimb"] = () => {
      throw refusal("CLIMB_NOT_FOUND", "Climb not found. List the project's climbs to find its id.");
    };
    const res = await request("GET", `${CLIMBS}/${CLIMB}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ details: { code: "CLIMB_NOT_FOUND" } });
  });

  it("lists a suite's climbs", async () => {
    queries["climbs:listClimbs"] = (args) => [{ climbId: CLIMB, suiteId: args.suiteId, serverName: "Echo", state: "ready", measure: "pass_rate", roundsStarted: 0, roundLimit: 3, createdAt: 1 }];
    const res = await request("GET", `${CLIMBS}?suiteId=${SUITE}&limit=5`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).items[0].climbId).toBe(CLIMB);
    expect(mocks.query.mock.calls.find(([fn]) => nameOf(fn) === "climbs:listClimbs")![1]).toEqual({ projectId: PROJECT, suiteId: SUITE, limit: 5 });
  });

  it("updates what a climb is for, and answers a locked measure as a conflict", async () => {
    mutations["climbs:updateClimb"] = (args) => climbRow({ measure: args.measure });
    const ok = await request("PATCH", `${CLIMBS}/${CLIMB}`, { measure: "tokens", targetBps: 500 });
    expect(ok.status).toBe(200);
    expect(calls(mocks.mutation, "climbs:updateClimb")[0]).toEqual({ climbId: CLIMB, measure: "tokens", targetBps: 500 });

    mutations["climbs:updateClimb"] = () => {
      throw refusal("CLIMB_MEASURE_LOCKED", "Round 1 has settled, so what the climb is for can no longer change.");
    };
    const locked = await request("PATCH", `${CLIMBS}/${CLIMB}`, { measure: "cost" });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({ details: { code: "CLIMB_MEASURE_LOCKED" } });
  });
});

describe("rounds", () => {
  const ROUNDS = `${CLIMBS}/${CLIMB}/rounds`;
  const roundGroup = (role: string) => {
    const idempotencyKey = `climb:${CLIMB}:round:1:${role}`;
    return {
      role,
      runGroupId: runGroupIdFor(SUITE, idempotencyKey),
      idempotencyKey,
      deadlineAt: 9,
      serverId: "s_candidate",
      serverVersion: "3",
      environmentIds: ["env_a"],
      caseIds: ["case_1"],
      status: "registered",
    };
  };

  beforeEach(() => {
    queries["climbRounds:planClimbRound"] = () => ({ allowed: true, candidateCaseIds: ["case_1"], remeasureBest: null });
    // The candidate changes a description: a field every client reads.
    queries["mockServers:getMock"] = () => ({
      version: 3,
      definitionJson: JSON.stringify({ tools: { search: { description: "Search the index." } } }),
    });
    queries["projectEnvironments:resolveEnvironmentForLaunch"] = () => ({
      environmentRef: { environmentId: "env_a", name: "Staging", revision: 1 },
      hostId: "host_plain",
      selectedServerIds: ["s_real"],
      servers: [{ serverId: "s_real", name: "Echo" }],
    });
    queries["hosts:getHost"] = () => ({ config: { hostStyle: "mcpjam" } });
    mutations["climbRounds:beginClimbRound"] = () => ({
      roundNumber: 1,
      unitKey: "round:1",
      remeasureBest: false,
      groups: [roundGroup("candidate")],
    });
  });

  it("submits a round as the caller's surface and answers 202 with the runs", async () => {
    const res = await request(
      "POST",
      ROUNDS,
      { serverId: "s_candidate" },
      { "x-mcpjam-launcher": JSON.stringify({ kind: "mcp", client: "claude-code" }), "idempotency-key": "retry-1" },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ climbId: CLIMB, roundNumber: 1, unitKey: "round:1", replayed: false });
    expect(calls(mocks.mutation, "climbRounds:beginClimbRound")[0]).toMatchObject({
      serverId: "s_candidate",
      serverVersion: "3",
      idempotencyKey: "retry-1",
      submittedVia: "mcp",
    });
    expect(launches).toHaveLength(1);
    expect(launches[0]!.body).toMatchObject({ climbId: CLIMB, caseIds: ["case_1"] });
  });

  it("answers a round past the limit with what is needed and what is left, and runs nothing", async () => {
    mutations["climbRounds:beginClimbRound"] = () => {
      throw refusal("CLIMB_ROUND_LIMIT_REACHED", "The climb has used its 3 rounds.", { needed: 1, left: 0 });
    };
    const res = await request("POST", ROUNDS, { serverId: "s_candidate" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ details: { code: "CLIMB_ROUND_LIMIT_REACHED", needed: 1, left: 0 } });
    expect(launches).toEqual([]);
  });

  it("answers a second round while one runs by its code", async () => {
    queries["climbRounds:planClimbRound"] = () => ({
      allowed: false,
      refusal: { code: "CLIMB_ROUND_IN_FLIGHT", message: "Round 1 is still running. Wait for it, or stop the climb." },
      candidateCaseIds: [],
      remeasureBest: null,
    });
    const res = await request("POST", ROUNDS, { serverId: "s_candidate" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ details: { code: "CLIMB_ROUND_IN_FLIGHT" } });
    expect(calls(mocks.mutation, "climbRounds:beginClimbRound")).toEqual([]);
  });

  it("refuses a round whose only change no client of the climb reads, before any quote or run", async () => {
    queries["mockServers:getMock"] = () => ({
      version: 3,
      definitionJson: JSON.stringify({ tools: { search: { title: "Search" } } }),
    });
    const res = await request("POST", ROUNDS, { serverId: "s_candidate" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.message).toContain("No client in this climb reads what this round changes");
    expect(body.message).toContain("Claude Code");
    expect(body.details).toMatchObject({ code: "CLIMB_CHANGE_NOT_READ", unread: [{ field: "toolTitle" }] });
    expect(calls(mocks.mutation, "climbRounds:beginClimbRound")).toEqual([]);
    expect(launches).toEqual([]);
  });

  it("lets a round through that submits the best so far unchanged", async () => {
    queries["mockServers:getMock"] = () => ({ version: 1, definitionJson: "{}" });
    const res = await request("POST", ROUNDS, { serverId: "s_baseline" });
    expect(res.status).toBe(202);
  });

  it("refuses an unknown field and a missing server", async () => {
    expect((await request("POST", ROUNDS, { serverId: "s", mock: 1 })).status).toBe(400);
    expect((await request("POST", ROUNDS, {})).status).toBe(400);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("reads a round, holding for at most the wait asked for and no more than the cap", async () => {
    queries["climbRounds:getClimbRound"] = () => ({ number: 1, status: "settled", verdict: "kept", reasons: [] });
    const res = await request("GET", `${ROUNDS}/1?wait=10`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ climbId: CLIMB, suiteId: SUITE, number: 1, settled: true });
    expect((await request("GET", `${ROUNDS}/1?wait=500`)).status).toBe(400);
    expect((await request("GET", `${ROUNDS}/0`)).status).toBe(404);
  });

  it("answers a round the climb does not have as not found", async () => {
    queries["climbRounds:getClimbRound"] = () => {
      throw refusal("CLIMB_ROUND_NOT_FOUND", "Round 9 does not exist on this climb.");
    };
    const res = await request("GET", `${ROUNDS}/9`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ details: { code: "CLIMB_ROUND_NOT_FOUND" } });
  });

  it("overrules a round with the reason, and answers a confirmed climb as a conflict", async () => {
    mutations["climbRounds:setClimbRoundDecision"] = (args) => ({ round: { number: args.roundNumber, standing: args.decision }, best: { roundNumber: 0 } });
    const ok = await request("POST", `${ROUNDS}/2/decision`, { decision: "kept", reason: "The failed case is flaky." });
    expect(ok.status).toBe(200);
    expect(calls(mocks.mutation, "climbRounds:setClimbRoundDecision")[0]).toEqual({
      climbId: CLIMB,
      roundNumber: 2,
      decision: "kept",
      reason: "The failed case is flaky.",
    });
    expect(await ok.json()).toMatchObject({ climbId: CLIMB, round: { standing: "kept" }, best: { roundNumber: 0 } });

    mutations["climbRounds:setClimbRoundDecision"] = () => {
      throw refusal("CLIMB_CONFIRMED", "The confirmation has run, so a round can no longer be overruled.");
    };
    const spent = await request("POST", `${ROUNDS}/2/decision`, { decision: "reverted", reason: "x" });
    expect(spent.status).toBe(409);
    expect((await request("POST", `${ROUNDS}/2/decision`, { decision: "maybe", reason: "x" })).status).toBe(400);
    expect((await request("POST", `${ROUNDS}/2/decision`, { decision: "kept", reason: "" })).status).toBe(400);
  });

  it("stops a climb and answers what stands as kept", async () => {
    mutations["climbRounds:stopClimb"] = () => ({ state: "stopped", stopReason: "stopped_by_caller", best: { roundNumber: 2 }, kept: [{ number: 2, serverId: "s_candidate", serverVersion: "3", validation: "better", overruled: false }] });
    queries["climbs:getClimb"] = () => climbRow({ state: "stopped", rounds: [{ number: 2, status: "settled", serverId: "s_candidate", serverVersion: "3", verdict: "kept", standing: "kept", reasons: [] }] });
    queries["mockServers:getMock"] = (args) => ({ definitionJson: JSON.stringify(args.version ? { tools: { search: { description: "Search the index." } } } : {}) });
    const res = await request("POST", `${CLIMBS}/${CLIMB}/stop`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ climbId: CLIMB, state: "stopped", kept: [{ number: 2 }] });
    expect(body.prompt).toContain("1. Round 2 (also better on validation cases)");
    expect(body.prompt).toContain("Now: Search the index.");
  });
});
