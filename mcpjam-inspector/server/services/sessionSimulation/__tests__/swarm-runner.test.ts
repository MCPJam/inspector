/**
 * swarm-runner.test.ts — single-host swarm (journey-execution) runner (PR 3c).
 *
 * Stubs the shared host-session core ({@link runSyntheticHostSession}) and the
 * swarm backend-client so these tests isolate the runner's own contract: the
 * claim→run→terminal attempt ordering, terminal-state mapping, per-session
 * failure isolation, and the independent heartbeat lifecycle. The integration
 * test (`swarm-runner.integration.test.ts`) drives the REAL core to prove
 * swarm attribution + persist-before-terminal end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reportAttemptMock = vi.fn();
const swarmPersonaNextTurnMock = vi.fn();
const heartbeatJourneyRunMock = vi.fn();
const runSyntheticHostSessionMock = vi.fn();

vi.mock("../../swarm-agent.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../swarm-agent.js")>(
      "../../swarm-agent.js"
    );
  return {
    ...actual,
    reportAttempt: (...args: unknown[]) => reportAttemptMock(...args),
    swarmPersonaNextTurn: (...args: unknown[]) =>
      swarmPersonaNextTurnMock(...args),
    heartbeatJourneyRun: (...args: unknown[]) => heartbeatJourneyRunMock(...args),
  };
});

vi.mock("../runner.js", async () => {
  const actual =
    await vi.importActual<typeof import("../runner.js")>("../runner.js");
  return {
    ...actual,
    runSyntheticHostSession: (...args: unknown[]) =>
      runSyntheticHostSessionMock(...args),
  };
});

import { startJourneyRun } from "../swarm-runner.js";

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
    host: HOST,
    personaSnapshot: {
      personaId: "p1",
      name: "Persona One",
      role: "tester",
      notes: "",
    },
    sessionsPerHost: 2,
    maxTurns: 3,
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
  reportAttemptMock.mockReset().mockResolvedValue(undefined);
  swarmPersonaNextTurnMock.mockReset();
  heartbeatJourneyRunMock.mockReset().mockResolvedValue(undefined);
  runSyntheticHostSessionMock.mockReset().mockResolvedValue({
    outcome: "succeeded",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("swarm single-host runner — attempt ordering", () => {
  it("claims (running + deterministic chatSessionId) BEFORE running, reports the terminal with the SAME chatSessionId AFTER, for every session", async () => {
    const order: string[] = [];
    reportAttemptMock.mockImplementation(async (_url, _bearer, args: any) => {
      order.push(`${args.status}:${args.sessionIdx}:${args.chatSessionId}`);
    });
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) => {
      order.push(`run:${adapter.chatSessionId}`);
      return { outcome: "succeeded" };
    });

    await startJourneyRun(baseOpts());

    expect(order).toEqual([
      "running:0:synth_run-1_host-1_0",
      "run:synth_run-1_host-1_0",
      "succeeded:0:synth_run-1_host-1_0",
      "running:1:synth_run-1_host-1_1",
      "run:synth_run-1_host-1_1",
      "succeeded:1:synth_run-1_host-1_1",
    ]);
  });

  it("passes the pinned host runtime + swarm persist attribution into the shared core", async () => {
    await startJourneyRun(baseOpts({ sessionsPerHost: 1 }));

    const adapter = runSyntheticHostSessionMock.mock.calls[0]![0] as any;
    expect(adapter.chatSessionId).toBe("synth_run-1_host-1_0");
    expect(adapter.runtime.modelDefinition.id).toBe(
      "anthropic/claude-haiku-4.5"
    );
    expect(adapter.runtime.chatboxId).toBeUndefined();
    expect(adapter.persist).toMatchObject({
      sourceType: "swarm",
      origin: "swarm",
      journeyRunId: "run-1",
      hostId: "host-1",
      personaId: "p1",
      personaLabel: "Persona One",
    });
    // Swarm has no chatbox surface — no chatbox-scoped side-persistence.
    expect(adapter.onTurnPersisted).toBeUndefined();
    // Persona driver routes through the swarm backend client.
    await adapter.nextPersonaTurn([{ role: "user", content: "hi" }]);
    expect(swarmPersonaNextTurnMock).toHaveBeenCalledWith(
      "https://convex.site",
      "token",
      expect.objectContaining({ runId: "run-1", hostId: "host-1" })
    );
  });
});

describe("swarm single-host runner — outcome mapping + isolation", () => {
  it("maps a session failure to a failed terminal and still runs the remaining sessions", async () => {
    runSyntheticHostSessionMock
      .mockResolvedValueOnce({ outcome: "failed", errorMessage: "boom" })
      .mockResolvedValueOnce({ outcome: "succeeded" });

    await startJourneyRun(baseOpts());

    const terminals = reportAttemptMock.mock.calls
      .map((c) => c[2] as any)
      .filter((a) => a.status !== "running");
    expect(terminals.map((t) => t.status)).toEqual(["failed", "succeeded"]);

    const failed = terminals.find((t) => t.status === "failed")!;
    expect(failed.errorCode).toBe("session_failed");
    expect(failed.errorMessage).toBe("boom");
    expect(failed.chatSessionId).toBe("synth_run-1_host-1_0");
    // Failure of session 0 did not abort the batch.
    expect(runSyntheticHostSessionMock).toHaveBeenCalledTimes(2);
  });

  it("maps a rate-limited session to a rate_limited terminal", async () => {
    runSyntheticHostSessionMock.mockResolvedValue({
      outcome: "rate_limited",
      errorMessage: "Daily spend cap reached",
    });

    await startJourneyRun(baseOpts({ sessionsPerHost: 1 }));

    const terminal = reportAttemptMock.mock.calls
      .map((c) => c[2] as any)
      .find((a) => a.status !== "running")!;
    expect(terminal.status).toBe("rate_limited");
    expect(terminal.errorCode).toBe("rate_limited");
    expect(terminal.chatSessionId).toBe("synth_run-1_host-1_0");
  });

  it("skips a session whose claim fails (can't run without the claim) and still claims the next", async () => {
    reportAttemptMock.mockImplementation(async (_url, _bearer, args: any) => {
      if (args.status === "running" && args.sessionIdx === 0) {
        throw new Error("claim rejected");
      }
    });

    await startJourneyRun(baseOpts());

    // Session 0 never ran; session 1 claimed + ran.
    expect(runSyntheticHostSessionMock).toHaveBeenCalledTimes(1);
    expect(
      (runSyntheticHostSessionMock.mock.calls[0]![0] as any).chatSessionId
    ).toBe("synth_run-1_host-1_1");
  });
});

describe("swarm single-host runner — heartbeat", () => {
  it("fires the heartbeat on an independent 30s schedule (not gated on turn completion) and stops it on finally", async () => {
    vi.useFakeTimers();
    try {
      let resolveRun!: () => void;
      runSyntheticHostSessionMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRun = () => resolve({ outcome: "succeeded" });
          })
      );

      const done = startJourneyRun(baseOpts({ sessionsPerHost: 1 }));

      // Session is still running (its core promise is pending) — the heartbeat
      // must still fire purely on the interval.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeatJourneyRunMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeatJourneyRunMock).toHaveBeenCalledTimes(2);

      // Finish the session; the runner's finally clears the interval.
      resolveRun();
      await done;

      const countAtFinish = heartbeatJourneyRunMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(heartbeatJourneyRunMock.mock.calls.length).toBe(countAtFinish);
    } finally {
      vi.useRealTimers();
    }
  });
});
