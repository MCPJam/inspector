import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, postJson, expectJson } from "./helpers/test-app.js";
import { SwarmAgentError } from "../../../services/swarm-agent.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

const createJourneyRunMock = vi.fn();
const startJourneyRunMock = vi.fn();

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
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
  });

  it("passes maxHosts:1, returns 202 + runId, and starts the runner", async () => {
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
    const { status, data } = await expectJson<{ runId?: string }>(response);

    expect(status).toBe(202);
    expect(data.runId).toBe("run-1");

    // maxHosts:1 (the single-host guard) + the journeyId as journeyRefId.
    expect(createJourneyRunMock).toHaveBeenCalledTimes(1);
    const createArgs = createJourneyRunMock.mock.calls[0]![2] as any;
    expect(createArgs).toMatchObject({
      journeyRefId: "journey-1",
      launchKey: "lk-1",
      maxHosts: 1,
    });

    // The runner is started fire-and-forget after the response.
    await flushMacrotasks();
    expect(startJourneyRunMock).toHaveBeenCalledTimes(1);
    const startArgs = startJourneyRunMock.mock.calls[0]![0] as any;
    expect(startArgs).toMatchObject({
      runId: "run-1",
      projectId: "proj-1",
      sessionsPerHost: 2,
      maxTurns: 3,
    });
    expect(startArgs.host.hostId).toBe("host-0");
  });

  it("surfaces a multi-host journey rejection as a 4xx and never starts a runner", async () => {
    createJourneyRunMock.mockRejectedValue(
      new SwarmAgentError(
        400,
        "journey has more than one host",
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
    expect(JSON.stringify(data)).toMatch(/more than one host/i);
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
});
