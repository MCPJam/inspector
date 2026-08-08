import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `launchJourneyRun` — the launch, with the HTTP taken out of it.
 *
 * The extraction from `routes/web/swarm-runs.ts` exists so the v1 route can
 * reuse it rather than carry a second copy of a fan-out launcher. What these
 * pin is the ORDERING RULE that makes the function safe to call from either:
 *
 *   Once `createJourneyRun` returns, a DURABLE RUN ROW EXISTS. Anything that
 *   throws after that point orphans it — a run in the database with no runner,
 *   visible in the UI, advancing to nothing until the stale-run cron reaps it.
 *   So validation happens BEFORE the create, and the detached runner is started
 *   in a way that cannot throw back into the caller.
 *
 * And the DEDUPE rule, which is the difference between one billed run and two:
 * a replayed launch key must acknowledge the original and start NOTHING.
 */

const { createRunMock, startRunMock } = vi.hoisted(() => ({
  createRunMock: vi.fn(),
  startRunMock: vi.fn(),
}));

vi.mock("../../swarm-agent.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, createJourneyRun: createRunMock };
});
vi.mock("../swarm-runner.js", () => ({ startJourneyRun: startRunMock }));
vi.mock("../../../routes/web/auth.js", () => ({
  createAuthorizedManager: vi.fn(),
}));
vi.mock("../../evals/route-helpers.js", () => ({
  createConvexClient: vi.fn(),
}));

import { launchJourneyRun } from "../launch-journey-run.js";
import { SwarmAgentError } from "../../swarm-agent.js";

const DEPS = {
  bearerToken: "create-jwt",
  getRunBearer: async () => "run-jwt",
  xaaIssuer: "https://issuer.test",
  callerContext: {} as never,
};

const INPUT = {
  projectId: "proj_1",
  journeyRefId: "jrn_1",
  launchKey: "key-1",
};

const created = (overrides: Record<string, unknown> = {}) => ({
  runId: "run_1",
  projectId: "proj_1",
  snapshot: {
    hosts: [{ hostId: "h1", targetId: "t1", serverIds: [], modelId: "m" }],
    sessionsPerTarget: 1,
    maxTurns: 4,
  },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  startRunMock.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

/** The runner is started via setImmediate; let the microtask/timer queue drain. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("launchJourneyRun", () => {
  it("creates the run with the CREATE bearer and starts the runner", async () => {
    createRunMock.mockResolvedValue(created());

    const result = await launchJourneyRun(DEPS, INPUT);
    await settle();

    expect(result).toEqual({ runId: "run_1" });
    // The create runs inside the request, so it uses the request's bearer.
    expect(createRunMock.mock.calls[0]![1]).toBe("create-jwt");
    expect(startRunMock).toHaveBeenCalledTimes(1);
  });

  it("hands the runner a THUNK, not a captured token", async () => {
    // The run outlives the JWT that authorized it — a delegated token lives
    // about two hours and a wide fan-out runs longer. A captured string here
    // is the A-I2 bug rebuilt one layer up.
    createRunMock.mockResolvedValue(created());

    await launchJourneyRun(DEPS, INPUT);
    await settle();

    const opts = startRunMock.mock.calls[0]![0] as {
      getBearer: () => Promise<string>;
    };
    expect(typeof opts.getBearer).toBe("function");
    await expect(opts.getBearer()).resolves.toBe("run-jwt");
  });

  it("starts NOTHING when the launch key deduped onto an existing run", async () => {
    // The ORIGINAL launch's runner owns that run. A second runner would race
    // it — and its shutdown path (finalize-pending, abort finalizers, heartbeat
    // stop) can kill attempts the owner is still executing.
    createRunMock.mockResolvedValue(created({ deduped: true }));

    const result = await launchJourneyRun(DEPS, INPUT);
    await settle();

    expect(result).toEqual({ runId: "run_1", deduped: true });
    expect(startRunMock).not.toHaveBeenCalled();
  });

  it("forwards a backend 4xx as a caller-facing error, not a 500", async () => {
    createRunMock.mockRejectedValue(
      new SwarmAgentError(400, "This journey has no hosts")
    );

    await expect(launchJourneyRun(DEPS, INPUT)).rejects.toMatchObject({
      status: 400,
    });
    expect(startRunMock).not.toHaveBeenCalled();
  });

  it("does NOT swallow a backend 5xx into a 4xx", async () => {
    // A 400 tells the caller to change something. An upstream fault is not
    // theirs to fix, and dressing it as one sends them looking at their own
    // journey config during an incident.
    createRunMock.mockRejectedValue(new SwarmAgentError(503, "upstream down"));

    await expect(launchJourneyRun(DEPS, INPUT)).rejects.toMatchObject({
      status: 503,
    });
  });

  it("rejects a hostless snapshot AFTER create — and the run row is the cost", async () => {
    // Documenting the one place the ordering rule is violated by necessity:
    // only the create knows the pinned host set, so this check cannot happen
    // earlier. The run row exists and the stale-run cron reaps it; what must
    // not happen is starting a runner over zero hosts.
    createRunMock.mockResolvedValue(created({ snapshot: { hosts: [] } }));

    await expect(launchJourneyRun(DEPS, INPUT)).rejects.toMatchObject({
      status: 400,
    });
    expect(startRunMock).not.toHaveBeenCalled();
  });

  it("does not reject when the detached runner fails", async () => {
    // The caller already has its 202. A runner failure is logged, not thrown:
    // there is nobody left to tell, and an unhandled rejection here would take
    // the process down.
    createRunMock.mockResolvedValue(created());
    startRunMock.mockRejectedValue(new Error("runner exploded"));

    await expect(launchJourneyRun(DEPS, INPUT)).resolves.toMatchObject({
      runId: "run_1",
    });
    await settle();
  });

  it("passes the wave id and environment fan-out through to the create", async () => {
    createRunMock.mockResolvedValue(created());

    await launchJourneyRun(DEPS, {
      ...INPUT,
      waveId: "wave_9",
      environmentIds: ["env_1", "env_2"],
    });

    expect(createRunMock.mock.calls[0]![2]).toMatchObject({
      // `waveId` is the PUBLIC name; the backend still calls it
      // `swarmRunGroupId`, and this is the one place that translation happens.
      swarmRunGroupId: "wave_9",
      environmentIds: ["env_1", "env_2"],
    });
  });
});
