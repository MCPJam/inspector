/**
 * The runner's rubric-grading hook.
 *
 * The contract worth protecting is not "grading works" — that lives in
 * `run-swarm-checks.test.ts`. It is that grading is WIRED correctly:
 *
 *   - it fires for every terminal attempt that produced a session, INCLUDING
 *     failed ones (that is where tool-error and turn-count criteria pay off);
 *   - it is AWAITED, so a runner that dies mid-grade has already left a
 *     durable `pending`;
 *   - it can never take the attempt or the host loop down with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reportAttemptMock = vi.fn();
const swarmPersonaNextTurnMock = vi.fn();
const heartbeatJourneyRunMock = vi.fn();
const finalizePendingAttemptsMock = vi.fn();
const fetchPinnedSkillMock = vi.fn();
const runSyntheticHostSessionMock = vi.fn();
const captureWidgetSnapshotsMock = vi.fn();
const runSwarmChecksMock = vi.fn();

vi.mock("../../swarm-agent.js", async () => {
  const actual = await vi.importActual<typeof import("../../swarm-agent.js")>(
    "../../swarm-agent.js",
  );
  return {
    ...actual,
    reportAttempt: (...args: unknown[]) => reportAttemptMock(...args),
    swarmPersonaNextTurn: (...args: unknown[]) =>
      swarmPersonaNextTurnMock(...args),
    heartbeatJourneyRun: (...args: unknown[]) =>
      heartbeatJourneyRunMock(...args),
    finalizePendingAttempts: (...args: unknown[]) =>
      finalizePendingAttemptsMock(...args),
    fetchPinnedSkill: (...args: unknown[]) => fetchPinnedSkillMock(...args),
  };
});

vi.mock("../runner.js", async () => {
  const actual = await vi.importActual<typeof import("../runner.js")>(
    "../runner.js",
  );
  return {
    ...actual,
    runSyntheticHostSession: (...args: unknown[]) =>
      runSyntheticHostSessionMock(...args),
    captureAndPersistWidgetSnapshotsForSession: (...args: unknown[]) =>
      captureWidgetSnapshotsMock(...args),
  };
});

vi.mock("../../checks/run-swarm-checks.js", () => ({
  runSwarmChecks: (...args: unknown[]) => runSwarmChecksMock(...args),
}));

import { startJourneyRun } from "../swarm-runner.js";
import { __clearPinnedSkillCacheForTest } from "../pinned-skill-cache.js";

const HOST = {
  hostId: "host-1",
  hostName: "Host One",
  hostConfigId: "hc-1",
  modelId: "anthropic/claude-haiku-4.5",
  systemPrompt: "sys",
  requireToolApproval: false,
  serverIds: ["server-1"],
};

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    projectId: "proj-1",
    hosts: [HOST],
    personaSnapshot: {
      personaId: "p1",
      name: "Persona One",
      role: "tester",
      notes: "",
    },
    sessionsPerHost: 1,
    maxTurns: 3,
    hasRubric: true,
    convexHttpUrl: "https://convex.site",
    bearer: "token",
    authHeader: "Bearer token",
    managerFactory: async () => ({
      manager: {} as never,
      connectedServerIds: ["server-1"],
      dispose: async () => {},
    }),
    ...overrides,
  };
}

beforeEach(() => {
  reportAttemptMock.mockReset().mockResolvedValue({ ok: true, applied: true });
  swarmPersonaNextTurnMock.mockReset();
  heartbeatJourneyRunMock.mockReset().mockResolvedValue(undefined);
  finalizePendingAttemptsMock.mockReset().mockResolvedValue(undefined);
  fetchPinnedSkillMock.mockReset();
  runSyntheticHostSessionMock.mockReset().mockResolvedValue({
    outcome: "succeeded",
  });
  runSwarmChecksMock
    .mockReset()
    .mockResolvedValue({ status: "completed", results: [] });
  __clearPinnedSkillCacheForTest();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("swarm runner — rubric grading hook", () => {
  it("grades a succeeded attempt with the session the attempt claimed", async () => {
    await startJourneyRun(baseOpts());

    expect(runSwarmChecksMock).toHaveBeenCalledTimes(1);
    const call = runSwarmChecksMock.mock.calls[0][0];
    expect(call).toMatchObject({ projectId: "proj-1", runId: "run-1" });
    // The SAME deterministic session id the terminal reported — grading a
    // different session would silently attribute the verdict to the wrong row.
    const terminal = reportAttemptMock.mock.calls
      .map((c) => c[2] as { status: string; chatSessionId?: string })
      .find((a) => a.status === "succeeded");
    expect(call.chatSessionId).toBe(terminal?.chatSessionId);
  });

  it("ALSO grades a failed attempt — that is where error criteria pay off", async () => {
    runSyntheticHostSessionMock.mockResolvedValue({
      outcome: "failed",
      errorMessage: "tool blew up",
    });

    await startJourneyRun(baseOpts());

    expect(runSwarmChecksMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT grade a rate-limited attempt — no session, no transcript", async () => {
    runSyntheticHostSessionMock.mockResolvedValue({
      outcome: "rate_limited",
      errorMessage: "429 from provider",
    });

    await startJourneyRun(baseOpts());

    expect(runSwarmChecksMock).not.toHaveBeenCalled();
  });

  it("does not call the grader at all when the run has no rubric", async () => {
    await startJourneyRun(baseOpts({ hasRubric: false }));

    expect(runSwarmChecksMock).not.toHaveBeenCalled();
    // The attempt itself is unaffected.
    expect(
      reportAttemptMock.mock.calls.some((c) => (c[2] as any).status === "succeeded"),
    ).toBe(true);
  });

  it("AWAITS grading — the run does not finish before the grade lands", async () => {
    let resolveGrade: (() => void) | undefined;
    let gradeSettled = false;
    runSwarmChecksMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGrade = () => {
            gradeSettled = true;
            resolve({ status: "completed", results: [] });
          };
        }),
    );

    const running = startJourneyRun(baseOpts());
    // Wait for the grading call to actually happen rather than for a fixed
    // delay: a loaded CI worker that took longer than the sleep would leave
    // `resolveGrade` unset and hang `await running` forever.
    await vi.waitFor(() => expect(runSwarmChecksMock).toHaveBeenCalledTimes(1));
    // The run is parked on the deferred grade — proof it is awaited rather
    // than fire-and-forget.
    expect(gradeSettled).toBe(false);
    resolveGrade?.();
    await running;

    expect(gradeSettled).toBe(true);
  });

  it("ISOLATES a grading throw — the attempt and the host loop are untouched", async () => {
    runSwarmChecksMock.mockRejectedValue(new Error("backend exploded"));

    await expect(
      startJourneyRun(baseOpts({ sessionsPerHost: 2 })),
    ).resolves.toBeUndefined();

    // Both sessions still ran and both reported their terminal.
    expect(runSyntheticHostSessionMock).toHaveBeenCalledTimes(2);
    const terminals = reportAttemptMock.mock.calls
      .map((c) => c[2] as { status: string })
      .filter((a) => a.status === "succeeded");
    expect(terminals).toHaveLength(2);
  });

  it("grades AFTER the terminal is reported, so the transcript is durable first", async () => {
    const order: string[] = [];
    reportAttemptMock.mockImplementation(async (_url, _bearer, args: any) => {
      order.push(`report:${args.status}`);
      return { ok: true, applied: true };
    });
    runSwarmChecksMock.mockImplementation(async () => {
      order.push("grade");
      return { status: "completed", results: [] };
    });

    await startJourneyRun(baseOpts());

    expect(order).toEqual(["report:running", "report:succeeded", "grade"]);
  });
});
