vi.mock("../../../utils/harness/local/run-resources.js", () => ({ shouldUseLocalHarness: vi.fn(async () => true) }));
vi.mock("../../../utils/harness/local/readiness.js", () => ({ ensureLocalHarnessTarget: vi.fn(async () => ({ target: {} })) }));
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, postJson, expectJson } from "./helpers/test-app.js";
import { SwarmAgentError } from "../../../services/swarm-agent.js";
import { ErrorCode, WebRouteError } from "../errors.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

const createJourneyRunMock = vi.fn();
const startJourneyRunMock = vi.fn();
const createAuthorizedManagerMock = vi.fn();
const backgroundBearerMock = vi.fn();

vi.mock("../../../utils/v1-convex-token.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../utils/v1-convex-token.js")>(),
  getBackgroundRunBearerForRequest: (...args: unknown[]) => backgroundBearerMock(...args),
}));

vi.mock("../../../services/swarm-agent.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../services/swarm-agent.js")>(
      "../../../services/swarm-agent.js"
    );
  return {
    ...actual,
    createJourneyRun: (...args: unknown[]) => createJourneyRunMock(...args),
  };
});

vi.mock("../../../services/sessionSimulation/swarm-runner.js", async () => {
  const actual =
    await vi.importActual<
      typeof import("../../../services/sessionSimulation/swarm-runner.js")
    >("../../../services/sessionSimulation/swarm-runner.js");
  return {
    ...actual,
    startJourneyRun: (...args: unknown[]) => startJourneyRunMock(...args),
  };
});

// Partial mock: keep the real auth surface the test app needs; intercept only
// the manager builder so the captured managerFactory can be invoked in-test
// without a real MCP authorize batch.
vi.mock("../auth.js", async () => {
  const actual = await vi.importActual<typeof import("../auth.js")>(
    "../auth.js"
  );
  return {
    ...actual,
    createAuthorizedManager: (...args: unknown[]) =>
      createAuthorizedManagerMock(...args),
  };
});

// Deterministic XAA issuer (the real resolver reads request headers).
vi.mock("../../../services/xaa-mint.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/xaa-mint.js")
  >("../../../services/xaa-mint.js");
  return {
    ...actual,
    resolveXaaIssuer: () => "https://issuer.test/api/web/xaa",
  };
});

function snapshot(hostCount: number) {
  return {
    hosts: Array.from({ length: hostCount }, (_, i) => ({
      hostId: `host-${i}`,
      hostName: `Host ${i}`,
      hostConfigId: `hc-${i}`,
      modelId: "anthropic/claude-haiku-4.5",
      systemPrompt: "sys",
      requireToolApproval: false,
      serverIds: ["server-1"],
    })),
    personaSnapshot: {
      personaId: "p1",
      name: "Persona One",
      role: "tester",
      notes: "",
    },
    sessionsPerTarget: 2,
    maxTurns: 3,
  };
}

const flushMacrotasks = () => new Promise((r) => setImmediate(r));

describe("web routes — swarm single-host launch", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
    createJourneyRunMock.mockReset();
    backgroundBearerMock.mockReset().mockResolvedValue(async () => token);
    startJourneyRunMock.mockReset().mockResolvedValue(undefined);
    createAuthorizedManagerMock.mockReset().mockResolvedValue({
      // `listTools` is the readiness barrier the journey launcher awaits
      // before handing the manager to a session, so the stub has to answer it
      // (see launch-journey-run.ts).
      manager: {
        listTools: async () => [],
        disconnectAllServers: async () => {},
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
  });

  it("omits maxHosts, returns 202 + runId, and fans the runner over all hosts", async () => {
    createJourneyRunMock.mockResolvedValue({
      runId: "run-1",
      projectId: "proj-1",
      journeyRefId: "journey-1",
      snapshot: snapshot(3),
    });

    const response = await postJson(
      app,
      "/api/web/swarm/journeys/journey-1/runs",
      { projectId: "proj-1", launchKey: "lk-1" },
      token
    );
    const { status, data } = await expectJson<{ runId?: string }>(response);

    expect(status).toBe(202);
    expect(data.runId).toBe("run-1");

    // No maxHosts cap — the backend pins the journey's full host set.
    expect(createJourneyRunMock).toHaveBeenCalledTimes(1);
    const createArgs = createJourneyRunMock.mock.calls[0]![2] as any;
    expect(createArgs).toMatchObject({
      // projectId is REQUIRED by the backend create route — the route must
      // forward the client-supplied projectId (see the fetch-level contract
      // test in swarm-agent.test.ts that asserts it lands in the request body).
      projectId: "proj-1",
      journeyRefId: "journey-1",
      launchKey: "lk-1",
    });
    expect(createArgs.maxHosts).toBeUndefined();

    // The runner is started fire-and-forget with EVERY pinned host.
    await flushMacrotasks();
    expect(startJourneyRunMock).toHaveBeenCalledTimes(1);
    const startArgs = startJourneyRunMock.mock.calls[0]![0] as any;
    expect(startArgs).toMatchObject({
      runId: "run-1",
      projectId: "proj-1",
      sessionsPerTarget: 2,
      maxTurns: 3,
    });
    expect(startArgs.hosts.map((h: any) => h.hostId)).toEqual([
      "host-0",
      "host-1",
      "host-2",
    ]);
  });

  it("forwards expectedSponsored to the create and returns the funding the backend reports", async () => {
    createJourneyRunMock.mockResolvedValue({
      runId: "run-1",
      projectId: "proj-1",
      journeyRefId: "journey-1",
      snapshot: snapshot(1),
      funding: { sponsored: 2, credits: 0, total: 2 },
      sessions: [
        { targetId: "t0", sessionIdx: 0, funding: "starter" },
        { targetId: "t0", sessionIdx: 1, funding: "starter" },
      ],
    });

    const response = await postJson(
      app,
      "/api/web/swarm/journeys/journey-1/runs",
      { projectId: "proj-1", launchKey: "lk-fund", expectedSponsored: 2 },
      token
    );
    const { status, data } = await expectJson<any>(response);

    expect(status).toBe(202);
    expect(data.funding).toEqual({ sponsored: 2, credits: 0, total: 2 });
    expect(createJourneyRunMock.mock.calls[0]![2]).toMatchObject({
      expectedSponsored: 2,
    });
    await flushMacrotasks();
    expect(startJourneyRunMock.mock.calls[0]![0].sessionFunding).toHaveLength(2);
  });

  it("rejects a malformed expectedSponsored before creating anything", async () => {
    for (const expectedSponsored of [-1, 1.5, "2"]) {
      const response = await postJson(
        app,
        "/api/web/swarm/journeys/journey-1/runs",
        { projectId: "proj-1", launchKey: "lk-bad", expectedSponsored },
        token
      );
      expect(response.status).toBe(400);
    }
    expect(createJourneyRunMock).not.toHaveBeenCalled();
  });

  it("answers a funding mismatch with a typed 409 and starts no runner", async () => {
    createJourneyRunMock.mockRejectedValue(
      new SwarmAgentError(
        409,
        JSON.stringify({
          code: "swarm_funding_changed",
          details: {
            expectedSponsored: 5,
            actualSponsored: 0,
            totalConversations: 5,
          },
        }),
        "swarm-agent create failed (409)"
      )
    );

    const response = await postJson(
      app,
      "/api/web/swarm/journeys/journey-1/runs",
      { projectId: "proj-1", launchKey: "lk-409", expectedSponsored: 5 },
      token
    );
    const { status, data } = await expectJson<any>(response);

    expect(status).toBe(409);
    expect(data.details).toEqual({
      code: "swarm_funding_changed",
      expectedSponsored: 5,
      actualSponsored: 0,
      totalConversations: 5,
    });
    await flushMacrotasks();
    expect(startJourneyRunMock).not.toHaveBeenCalled();
  });

  it("does not create an orphaned run if background authorization fails", async () => {
    backgroundBearerMock.mockRejectedValueOnce(new WebRouteError(403, ErrorCode.FORBIDDEN, "Delegation refused"));
    const response = await postJson(app, "/api/web/swarm/journeys/journey-1/runs", { projectId: "proj-1", launchKey: "lk-auth-failure" }, token);
    expect(response.status).toBe(403);
    expect(backgroundBearerMock).toHaveBeenCalledWith(expect.anything(), "proj-1");
    expect(createJourneyRunMock).not.toHaveBeenCalled();
    expect(startJourneyRunMock).not.toHaveBeenCalled();
  });

  it("acknowledges a DEDUPED launch (launchKey replay) without starting a second runner", async () => {
    // Backend deduped the launchKey onto an EXISTING run — the original
    // launch's runner owns it. Starting another runner would race the owner's
    // claims and, worse, its shutdown/cleanup could finalize attempts the
    // owner is still executing.
    createJourneyRunMock.mockResolvedValue({
      runId: "run-existing",
      projectId: "proj-1",
      journeyRefId: "journey-1",
      snapshot: snapshot(1),
      deduped: true,
    });

    const response = await postJson(
      app,
      "/api/web/swarm/journeys/journey-1/runs",
      { projectId: "proj-1", launchKey: "lk-replayed" },
      token
    );
    const { status, data } = await expectJson<{
      runId?: string;
      deduped?: boolean;
    }>(response);

    // Idempotent ACK: same runId, 202, deduped marker — and NO second runner.
    expect(status).toBe(202);
    expect(data.runId).toBe("run-existing");
    expect(data.deduped).toBe(true);
    await flushMacrotasks();
    expect(startJourneyRunMock).not.toHaveBeenCalled();
  });

  it("surfaces a backend rejection (e.g. host-count ceiling) as a 4xx and never starts a runner", async () => {
    createJourneyRunMock.mockRejectedValue(
      new SwarmAgentError(
        400,
        "journey exceeds the maximum host count",
        "swarm-agent create failed (400)"
      )
    );

    const response = await postJson(
      app,
      "/api/web/swarm/journeys/journey-multi/runs",
      { projectId: "proj-1", launchKey: "lk-1" },
      token
    );
    const { status, data } = await expectJson<{
      error?: { message?: string };
    }>(response);

    expect(status).toBe(400);
    expect(JSON.stringify(data)).toMatch(/maximum host count/i);
    await flushMacrotasks();
    expect(startJourneyRunMock).not.toHaveBeenCalled();
  });

  it("rejects a journey snapshot with no pinned hosts and never starts a runner", async () => {
    createJourneyRunMock.mockResolvedValue({
      runId: "run-1",
      projectId: "proj-1",
      journeyRefId: "journey-1",
      snapshot: snapshot(0),
    });

    const response = await postJson(
      app,
      "/api/web/swarm/journeys/journey-1/runs",
      { projectId: "proj-1", launchKey: "lk-1" },
      token
    );
    const { status } = await expectJson(response);

    expect(status).toBe(400);
    await flushMacrotasks();
    expect(startJourneyRunMock).not.toHaveBeenCalled();
  });

  it("does NOT orphan the run on a client/backend projectId mismatch: a successful create always starts the runner using the backend-derived projectId", async () => {
    // The backend derives + authorizes the project from the journey. Even when
    // the client-supplied projectId differs, the route must NOT reject
    // post-create (which would leave a durable run row with no runner) — it
    // trusts the backend's gating and starts the runner with the authoritative
    // (backend) projectId.
    createJourneyRunMock.mockResolvedValue({
      runId: "run-1",
      projectId: "proj-REAL",
      journeyRefId: "journey-1",
      snapshot: snapshot(1),
    });

    const response = await postJson(
      app,
      "/api/web/swarm/journeys/journey-1/runs",
      { projectId: "proj-WRONG", launchKey: "lk-1" },
      token
    );
    const { status, data } = await expectJson<{ runId?: string }>(response);

    expect(status).toBe(202);
    expect(data.runId).toBe("run-1");
    await flushMacrotasks();
    expect(startJourneyRunMock).toHaveBeenCalledTimes(1);
    const startArgs = startJourneyRunMock.mock.calls[0]![0] as any;
    // Runner uses the backend-derived project, not the client's.
    expect(startArgs.projectId).toBe("proj-REAL");
  });

  it("threads pinned mcpProfile INITIALIZE pins + clientCapabilities (NOT the scrubbed connectionDefaults) into the manager", async () => {
    const snap = snapshot(1);
    // The backend snapshot carries INITIALIZE pins on `mcpProfile` and scrubs
    // `connectionDefaults` down to just `{ requestTimeout }`. A stale reader that
    // pulled pins from connectionDefaults would find nothing.
    (snap.hosts[0] as any).mcpProfile = {
      profileVersion: 1,
      mcpProtocolVersion: "2025-06-18",
      initialize: {
        supportedProtocolVersions: ["2025-06-18"],
        clientInfo: { name: "Pinned Host", version: "9.9.9" },
      },
    };
    (snap.hosts[0] as any).clientCapabilities = { roots: { listChanged: true } };
    (snap.hosts[0] as any).connectionDefaults = { requestTimeout: 12345 };
    createJourneyRunMock.mockResolvedValue({
      runId: "run-1",
      projectId: "proj-1",
      journeyRefId: "journey-1",
      snapshot: snap,
    });

    const response = await postJson(
      app,
      "/api/web/swarm/journeys/journey-1/runs",
      { projectId: "proj-1", launchKey: "lk-1" },
      token
    );
    expect((await expectJson(response)).status).toBe(202);
    await flushMacrotasks();

    // Invoke the captured host-aware managerFactory for the pinned host
    // (startJourneyRun is mocked, so the route's closure never ran on its own).
    const startArgs = startJourneyRunMock.mock.calls[0]![0] as any;
    await startArgs.managerFactory(startArgs.hosts[0]);

    expect(createAuthorizedManagerMock).toHaveBeenCalledTimes(1);
    const call = createAuthorizedManagerMock.mock.calls[0]!;
    // 7th positional arg = clientCapabilities (mirrors the scenario path).
    expect(call[6]).toEqual({ roots: { listChanged: true } });
    const options = call[7] as any;
    // INITIALIZE pins come from mcpProfile, not connectionDefaults.
    expect(options.initializePins).toEqual({
      clientInfo: { name: "Pinned Host", version: "9.9.9" },
      supportedProtocolVersions: ["2025-06-18"],
      mcpProtocolVersion: "2025-06-18",
    });
    // Timeout still honors the retained connectionDefaults.requestTimeout.
    expect(call[4]).toBe(12345);
  });

  it("passes a resolved xaaIssuer into the manager options (a useXaa server fails closed without it)", async () => {
    createJourneyRunMock.mockResolvedValue({
      runId: "run-1",
      projectId: "proj-1",
      journeyRefId: "journey-1",
      snapshot: snapshot(1),
    });

    const response = await postJson(
      app,
      "/api/web/swarm/journeys/journey-1/runs",
      { projectId: "proj-1", launchKey: "lk-1" },
      token
    );
    expect((await expectJson(response)).status).toBe(202);
    await flushMacrotasks();

    const startArgs = startJourneyRunMock.mock.calls[0]![0] as any;
    await startArgs.managerFactory(startArgs.hosts[0]);

    const options = createAuthorizedManagerMock.mock.calls[0]![7] as any;
    expect(options.xaaIssuer).toBe("https://issuer.test/api/web/xaa");
  });

  // Project-Environments Phase 4 guard. The environment→host resolution lives
  // ENTIRELY in the backend `createJourneyRun` transaction, which freezes it
  // into `snapshot.hosts`. The inspector must consume that frozen list VERBATIM
  // and never re-resolve environments itself — a second resolution here would
  // duplicate the backend transaction and open a time-of-check/time-of-use gap.
  it("consumes created.snapshot.hosts VERBATIM — no second environment resolution in the inspector", async () => {
    const snap = snapshot(2);
    createJourneyRunMock.mockResolvedValue({
      runId: "run-env",
      projectId: "proj-1",
      journeyRefId: "journey-env",
      // A journey may be env-based, but the ENVELOPE the route sees is the same
      // frozen host snapshot; `environmentIds` never reaches this route.
      snapshot: snap,
    });

    const response = await postJson(
      app,
      "/api/web/swarm/journeys/journey-env/runs",
      // `environmentIds` is now a documented per-run parameter: it selects the
      // fan-out for one launch instead of rewriting the journey definition.
      { projectId: "proj-1", launchKey: "lk-env", environmentIds: ["env-1"] },
      token
    );
    expect((await expectJson(response)).status).toBe(202);
    await flushMacrotasks();

    // Forwarded OPAQUELY — the route selects, it never resolves. Turning these
    // ids into hosts stays the backend transaction's job (enforced separately
    // by the static no-resolver guard below), so the time-of-check/
    // time-of-use gap a second resolution here would open still cannot exist.
    expect(createJourneyRunMock).toHaveBeenCalledTimes(1);
    const createArgs = createJourneyRunMock.mock.calls[0]![2] as Record<
      string,
      unknown
    >;
    expect(createArgs).toEqual({
      runtimeVenue: "hosted",
      projectId: "proj-1",
      journeyRefId: "journey-env",
      kind: "user_testing",
      launchKey: "lk-env",
      environmentIds: ["env-1"],
    });

    // The runner receives the SAME hosts object the backend snapshot froze —
    // proving the route passed it straight through rather than rebuilding a
    // host list from any environment resolution.
    const startArgs = startJourneyRunMock.mock.calls[0]![0] as any;
    expect(startArgs.hosts).toBe(snap.hosts);
  });

  it("the swarm-runs route imports no environment resolver (static guard)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../swarm-runs.ts", import.meta.url)),
      "utf8"
    );
    // None of the environment-resolution entrypoints may appear in this route:
    // resolution is the backend transaction's job, frozen into snapshot.hosts.
    expect(source).not.toMatch(/resolveEnvironmentForLaunch/);
    expect(source).not.toMatch(/resolveEnvironmentForRuntime/);
    expect(source).not.toMatch(/services\/environments/);
  });
});

describe("web routes — swarm funding preview", () => {
  const { app, token } = createWebTestApp();
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
  });

  const BODY = {
    projectId: "proj-1",
    runs: [{ journeyRefId: "journey-1", sessionsPerTarget: 3 }],
  };

  it("proxies the backend preview with the runner capability this server asserts", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    fetchMock.mockImplementation(async () =>
      Response.json({
        supported: true,
        remaining: 490,
        granted: 500,
        runs: [{ sponsored: 4, credits: 2, total: 6, targets: [] }],
      })
    );

    const response = await postJson(
      app,
      "/api/web/swarm/funding-preview",
      BODY,
      token
    );
    const { status, data } = await expectJson<any>(response);

    expect(status).toBe(200);
    expect(data).toMatchObject({
      supported: true,
      remaining: 490,
      runs: [{ sponsored: 4, credits: 2, total: 6 }],
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://test-deployment.convex.site/journey-execution/funding-preview"
    );
    const sent = JSON.parse((init as RequestInit).body as string);
    // Asserted by this process; a caller cannot claim the capability.
    expect(sent.runnerCapabilities).toContain("swarm-sponsorship-v1");
    expect(sent.runs).toEqual(BODY.runs);
  });

  // The wizard launches every run as part of a swarm wave, which the launch
  // turns into `kind: "swarm"`. A preview that leaves the kind out is resolved by
  // the backend from the session count, so a one-conversation goal previews as
  // user testing (never sponsored) and then launches as a swarm (sponsored): the
  // split the person was shown is refused at launch, every time.
  it("forwards the kind a launch will use instead of stripping it", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    fetchMock.mockImplementation(async () =>
      Response.json({
        supported: true,
        remaining: 500,
        granted: 500,
        runs: [{ sponsored: 1, credits: 0, total: 1, targets: [] }],
      })
    );

    const response = await postJson(
      app,
      "/api/web/swarm/funding-preview",
      {
        projectId: "proj-1",
        runs: [
          { journeyRefId: "journey-1", kind: "swarm" },
          { journeyRefId: "journey-2", kind: "user_testing" },
        ],
      },
      token
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).runs).toEqual([
      { journeyRefId: "journey-1", kind: "swarm" },
      { journeyRefId: "journey-2", kind: "user_testing" },
    ]);
  });

  it("refuses a kind a launch does not take, without asking the backend", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");

    const response = await postJson(
      app,
      "/api/web/swarm/funding-preview",
      {
        projectId: "proj-1",
        runs: [{ journeyRefId: "journey-1", kind: "sponsored" }],
      },
      token
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a capability the caller tries to supply", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");

    const response = await postJson(
      app,
      "/api/web/swarm/funding-preview",
      { ...BODY, runnerCapabilities: ["swarm-sponsorship-v1"] },
      token
    );
    const { data } = await expectJson<any>(response);

    expect(data).toMatchObject({ supported: false, remaining: 0, runs: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers supported:false without asking the backend when the server has no service token", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");

    const response = await postJson(
      app,
      "/api/web/swarm/funding-preview",
      BODY,
      token
    );
    const { status, data } = await expectJson<any>(response);

    expect(status).toBe(200);
    expect(data.supported).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the allowance alone when there are no runs to preview", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    fetchMock.mockImplementation(async () =>
      Response.json({ supported: true, remaining: 7, granted: 500, runs: [] })
    );

    const response = await postJson(
      app,
      "/api/web/swarm/funding-preview",
      { projectId: "proj-1", runs: [] },
      token
    );
    const { status, data } = await expectJson<any>(response);

    expect(status).toBe(200);
    expect(data).toMatchObject({ supported: true, remaining: 7, granted: 500 });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).runs).toEqual([]);
  });

  // The backend rejects an out-of-range iterations count with a 400 and the
  // reason as a plain `error` string. That is the caller's request to fix, so it
  // stays a 400 with the reason (the Inspector does not repeat the bound, which
  // would drift from the backend's), not a 500 from an unhandled rethrow.
  it("answers a request the backend refused as a 400 with its reason, not a 500", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            code: "invalid_request",
            error: "sessionsPerTarget must be between 1 and 5",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );

    const response = await postJson(
      app,
      "/api/web/swarm/funding-preview",
      {
        projectId: "proj-1",
        runs: [{ journeyRefId: "journey-1", sessionsPerTarget: 99 }],
      },
      token,
    );
    const { status, data } = await expectJson<any>(response);

    expect(status).toBe(400);
    expect(JSON.stringify(data)).toContain(
      "sessionsPerTarget must be between 1 and 5",
    );
    // Never the deployment URL the upstream error message carries.
    expect(JSON.stringify(data)).not.toContain("convex.site");
  });

  // Every 4xx is the backend refusing the REQUEST. Rethrown as is, a 403
  // surfaced as an upstream-auth failure whose message names the deployment, and
  // a 409 as a 500 that pages the on-call for a conflict the caller can read.
  it.each([
    [403, "forbidden", "You are not a member of this project's organization."],
    [409, "conflict", "The preview conflicts with this project's state."],
    [422, "unprocessable", "These runs cannot be previewed together."],
  ])(
    "keeps a backend %s at that status with its plain sentence, never the deployment URL",
    async (status, code, error) => {
      vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
      fetchMock.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              code,
              error,
              internalNote: "backend-only-detail",
            }),
            { status, headers: { "content-type": "application/json" } },
          ),
      );

      const response = await postJson(
        app,
        "/api/web/swarm/funding-preview",
        BODY,
        token,
      );
      const { status: got, data } = await expectJson<any>(response);

      expect(got).toBe(status);
      expect(JSON.stringify(data)).toContain(error);
      expect(JSON.stringify(data)).not.toContain("convex.site");
      // Only the sentence is forwarded, never the envelope the backend sent.
      expect(JSON.stringify(data)).not.toContain("backend-only-detail");
    },
  );

  it("still fails a backend 5xx as a server error", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    fetchMock.mockImplementation(
      async () => new Response("upstream exploded", { status: 503 }),
    );

    const response = await postJson(
      app,
      "/api/web/swarm/funding-preview",
      BODY,
      token,
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  // A backend body is not trusted to be a sentence. The reason passes only when
  // it is one short plain line, by the same rule a launch refusal's reason is
  // held to; anything else is replaced by a sentence of ours. A form feed and the
  // Unicode separators break a line on screen as surely as a newline does.
  describe("a refused preview whose reason is not one plain sentence", () => {
    const FALLBACK = "could not be previewed for this request";
    const refuse = async (body: BodyInit) => {
      vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
      fetchMock.mockImplementation(
        async () => new Response(body, { status: 400 }),
      );
      const response = await postJson(
        app,
        "/api/web/swarm/funding-preview",
        BODY,
        token,
      );
      return expectJson<any>(response);
    };

    it.each([
      ["markup", "<html>bad gateway</html>"],
      ["a newline", "first\nsecond"],
      ["a carriage return", "first\rsecond"],
      ["a form feed", "first\fsecond"],
      ["a vertical tab", "first\vsecond"],
      ["a next-line character", "first\u0085second"],
      ["a Unicode line separator", "first second"],
      ["a Unicode paragraph separator", "first second"],
      ["more than a sentence", "x".repeat(301)],
      ["nothing but spaces", "   "],
    ])("says our own sentence for %s", async (_label, reason) => {
      const { status, data } = await refuse(JSON.stringify({ error: reason }));

      expect(status).toBe(400);
      expect(JSON.stringify(data)).toContain(FALLBACK);
      expect(JSON.stringify(data)).not.toContain("first");
      expect(JSON.stringify(data)).not.toContain("bad gateway");
      expect(JSON.stringify(data)).not.toContain("xxxxxxxx");
    });

    it.each([
      ["a body that is not JSON", "Bad Request"],
      ["a body with no reason", JSON.stringify({ ok: false })],
      ["a reason that is not a string", JSON.stringify({ error: { a: 1 } })],
    ])("says our own sentence for %s", async (_label, body) => {
      const { status, data } = await refuse(body);

      expect(status).toBe(400);
      expect(JSON.stringify(data)).toContain(FALLBACK);
    });
  });

  it("still fails a backend server error as a server error", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    fetchMock.mockImplementation(
      async () => new Response("boom", { status: 502 }),
    );

    const response = await postJson(
      app,
      "/api/web/swarm/funding-preview",
      BODY,
      token,
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  it("validates the body", async () => {
    for (const body of [
      { runs: [{ journeyRefId: "j" }] },
      { projectId: "proj-1" },
      { projectId: "proj-1", runs: [{ sessionsPerTarget: 1 }] },
    ]) {
      const response = await postJson(
        app,
        "/api/web/swarm/funding-preview",
        body,
        token
      );
      expect(response.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
