import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, postJson, expectJson } from "./helpers/test-app.js";
import { SwarmAgentError } from "../../../services/swarm-agent.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

const createJourneyRunMock = vi.fn();
const startJourneyRunMock = vi.fn();
const createAuthorizedManagerMock = vi.fn();

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
    sessionsPerHost: 2,
    maxTurns: 3,
  };
}

const flushMacrotasks = () => new Promise((r) => setImmediate(r));

describe("web routes — swarm single-host launch", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
    createJourneyRunMock.mockReset();
    startJourneyRunMock.mockReset().mockResolvedValue(undefined);
    createAuthorizedManagerMock.mockReset().mockResolvedValue({
      manager: { disconnectAllServers: async () => {} },
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
      sessionsPerHost: 2,
      maxTurns: 3,
    });
    expect(startArgs.hosts.map((h: any) => h.hostId)).toEqual([
      "host-0",
      "host-1",
      "host-2",
    ]);
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
    // 7th positional arg = clientCapabilities (mirrors the chatbox path).
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
});
