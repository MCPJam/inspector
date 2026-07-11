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

const finalizePendingAttemptsMock = vi.fn();

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
    finalizePendingAttempts: (...args: unknown[]) =>
      finalizePendingAttemptsMock(...args),
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

import {
  startJourneyRun,
  shutdownRunningJourneyRuns,
  MAX_CONCURRENT_HOSTS,
} from "../swarm-runner.js";

const HOST = {
  hostId: "host-1",
  hostName: "Host One",
  hostConfigId: "hc-1",
  modelId: "anthropic/claude-haiku-4.5",
  systemPrompt: "sys",
  requireToolApproval: false,
  serverIds: ["server-1"],
};

const HOST_2 = {
  hostId: "host-2",
  hostName: "Host Two",
  hostConfigId: "hc-2",
  modelId: "anthropic/claude-haiku-4.5",
  systemPrompt: "sys",
  requireToolApproval: false,
  serverIds: ["server-2"],
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
  // Default: every attempt transition APPLIES (a fresh, uncontended claim/
  // terminal). Duplicate-launch tests override with `applied: false`.
  reportAttemptMock.mockReset().mockResolvedValue({ ok: true, applied: true });
  swarmPersonaNextTurnMock.mockReset();
  heartbeatJourneyRunMock.mockReset().mockResolvedValue(undefined);
  finalizePendingAttemptsMock.mockReset().mockResolvedValue(undefined);
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
      return { ok: true, applied: true };
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
      return { ok: true, applied: true };
    });

    await startJourneyRun(baseOpts());

    // Session 0 never ran; session 1 claimed + ran.
    expect(runSyntheticHostSessionMock).toHaveBeenCalledTimes(1);
    expect(
      (runSyntheticHostSessionMock.mock.calls[0]![0] as any).chatSessionId
    ).toBe("synth_run-1_host-1_1");
  });

  it("duplicate launch: a claim the backend reports NOT applied (owned by another runner) skips the session — no run, no persist, no bill, no terminal", async () => {
    // A duplicate-delivered launchKey dedupes to the SAME runId, so a sibling
    // runner iterates the SAME (run, host, sessionIdx) and wins the pending →
    // running transition. The backend returns `applied: false` to THIS runner's
    // claim (a no-op replay). It must NOT execute — running would double-bill.
    // Session 0 loses its claim; session 1 wins its own.
    reportAttemptMock.mockImplementation(async (_url, _bearer, args: any) => {
      if (args.status === "running") {
        return { ok: true, applied: args.sessionIdx !== 0 };
      }
      return { ok: true, applied: true };
    });

    await startJourneyRun(baseOpts());

    // Session 0 (applied:false) never executed; only session 1 (applied:true) ran.
    expect(runSyntheticHostSessionMock).toHaveBeenCalledTimes(1);
    expect(
      (runSyntheticHostSessionMock.mock.calls[0]![0] as any).chatSessionId
    ).toBe("synth_run-1_host-1_1");

    // The lost claim reports NO terminal (only the winning runner does). The one
    // running claim for session 0, the winning claim + terminal for session 1.
    const calls = reportAttemptMock.mock.calls.map((c) => c[2] as any);
    const session0 = calls.filter((a) => a.sessionIdx === 0);
    expect(session0.map((a) => a.status)).toEqual(["running"]); // claim only
    const session1 = calls.filter((a) => a.sessionIdx === 1);
    expect(session1.some((a) => a.status === "running")).toBe(true);
    expect(session1.some((a) => a.status !== "running")).toBe(true); // terminal
  });
});

describe("swarm fan-out runner — shutdown unwinds via cancellable persona", () => {
  it("forwards the run signal into the persona call so a PARKED session unwinds and self-reports its terminal ONCE via the normal path (no eager runner_shutdown race)", async () => {
    // The persona driver models the previously-uncancellable park: it resolves
    // ONLY when its forwarded signal aborts (as `AbortSignal.any` → fetch abort
    // does in prod). We capture the signal to prove it was threaded through.
    let personaSignal: AbortSignal | undefined;
    swarmPersonaNextTurnMock.mockImplementation(
      (_url: unknown, _bearer: unknown, args: any) =>
        new Promise((_resolve, reject) => {
          personaSignal = args.signal;
          args.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        })
    );

    const reportTimeline: string[] = [];
    reportAttemptMock.mockImplementation(async (_u, _b, args: any) => {
      reportTimeline.push(args.status);
      return { ok: true, applied: true };
    });

    // The shared core drives the persona, then — because the persona fetch is
    // now cancellable — unwinds to `failed` and returns. The runner reports the
    // terminal only AFTER this resolves (persist-before-terminal).
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) => {
      try {
        await adapter.nextPersonaTurn([]);
        return { outcome: "succeeded" };
      } catch {
        return { outcome: "failed" };
      }
    });

    const runPromise = startJourneyRun(baseOpts({ sessionsPerHost: 1 }));
    // Let the claim resolve and the core enter the (parked) persona call.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Graceful shutdown aborts the run — this must cancel the parked persona
    // fetch so the session unwinds promptly.
    await shutdownRunningJourneyRuns(1_000);
    await runPromise;

    // The run's abort signal was forwarded into the persona call.
    expect(personaSignal).toBeInstanceOf(AbortSignal);

    const calls = reportAttemptMock.mock.calls.map((c) => c[2] as any);
    // No eager per-attempt runner_shutdown report races the normal terminal.
    expect(calls.some((a) => a.errorCode === "runner_shutdown")).toBe(false);
    // Exactly one terminal, reported via the normal path AFTER the claim, with
    // the same chatSessionId (persist-before-terminal preserved).
    const terminals = calls.filter((a) => a.status !== "running");
    expect(terminals).toHaveLength(1);
    expect(terminals[0].status).toBe("failed");
    expect(terminals[0].chatSessionId).toBe("synth_run-1_host-1_0");
    expect(reportTimeline).toEqual(["running", "failed"]);
  });

  it("does NOT misclassify a session that SUCCEEDS just as abort fires — its succeeded terminal wins, exactly once, no runner_shutdown", async () => {
    // The core finished all turns (persisted) and returns `succeeded` even
    // though the run is being aborted concurrently.
    runSyntheticHostSessionMock.mockImplementation(async () => {
      return { outcome: "succeeded" };
    });

    const runPromise = startJourneyRun(baseOpts({ sessionsPerHost: 1 }));
    await Promise.resolve();
    await shutdownRunningJourneyRuns(1_000);
    await runPromise;

    const calls = reportAttemptMock.mock.calls.map((c) => c[2] as any);
    expect(calls.some((a) => a.errorCode === "runner_shutdown")).toBe(false);
    const terminals = calls.filter((a) => a.status !== "running");
    expect(terminals).toHaveLength(1);
    expect(terminals[0].status).toBe("succeeded");
    expect(terminals[0].chatSessionId).toBe("synth_run-1_host-1_0");
  });
});

describe("swarm fan-out runner — worker pool + host isolation", () => {
  const attemptAdapter = (call: unknown[]) => call[0] as any;
  const executedForHost = (hostId: string) =>
    runSyntheticHostSessionMock.mock.calls
      .map(attemptAdapter)
      .filter((a) => a.persist.hostId === hostId);
  const terminals = () =>
    reportAttemptMock.mock.calls
      .map((c) => c[2] as any)
      .filter((a) => a.status !== "running");

  it("fans out sessionsPerHost sessions per host across a 2-host journey (2/host = 4)", async () => {
    await startJourneyRun(
      baseOpts({ hosts: [HOST, HOST_2], sessionsPerHost: 2 })
    );

    expect(runSyntheticHostSessionMock).toHaveBeenCalledTimes(4);
    const sessionIds = runSyntheticHostSessionMock.mock.calls
      .map((c) => (c[0] as any).chatSessionId)
      .sort();
    expect(sessionIds).toEqual([
      "synth_run-1_host-1_0",
      "synth_run-1_host-1_1",
      "synth_run-1_host-2_0",
      "synth_run-1_host-2_1",
    ]);
    // A fresh manager per attempt: managerFactory bound to each host.
    expect(executedForHost("host-1")).toHaveLength(2);
    expect(executedForHost("host-2")).toHaveLength(2);
  });

  it(`runs at most ${MAX_CONCURRENT_HOSTS} hosts concurrently (pool bound)`, async () => {
    let active = 0;
    let maxActive = 0;
    runSyntheticHostSessionMock.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { outcome: "succeeded" };
    });
    const hosts = Array.from({ length: 5 }, (_, i) => ({
      ...HOST,
      hostId: `host-${i}`,
      serverIds: [`server-${i}`],
    }));

    await startJourneyRun(baseOpts({ hosts, sessionsPerHost: 1 }));

    expect(runSyntheticHostSessionMock).toHaveBeenCalledTimes(5);
    expect(maxActive).toBeLessThanOrEqual(MAX_CONCURRENT_HOSTS);
    expect(maxActive).toBe(MAX_CONCURRENT_HOSTS);
  });

  it("keeps one active session per host (sessions run sequentially within a host)", async () => {
    const activeByHost = new Map<string, number>();
    let maxPerHost = 0;
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) => {
      const hostId = adapter.persist.hostId;
      const n = (activeByHost.get(hostId) ?? 0) + 1;
      activeByHost.set(hostId, n);
      maxPerHost = Math.max(maxPerHost, n);
      await new Promise((r) => setTimeout(r, 3));
      activeByHost.set(hostId, n - 1);
      return { outcome: "succeeded" };
    });

    await startJourneyRun(
      baseOpts({ hosts: [HOST, HOST_2], sessionsPerHost: 3 })
    );

    expect(maxPerHost).toBe(1);
    expect(runSyntheticHostSessionMock).toHaveBeenCalledTimes(6);
  });

  it("a forced failure on one host does not stop the other host", async () => {
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) => {
      if (adapter.persist.hostId === "host-1") {
        return { outcome: "failed", errorMessage: "boom" };
      }
      return { outcome: "succeeded" };
    });

    await startJourneyRun(
      baseOpts({ hosts: [HOST, HOST_2], sessionsPerHost: 2 })
    );

    // Every session on both hosts ran — a failure isolates to its attempt.
    expect(executedForHost("host-1")).toHaveLength(2);
    expect(executedForHost("host-2")).toHaveLength(2);
    const host2 = terminals().filter((t) => t.hostId === "host-2");
    expect(host2.map((t) => t.status)).toEqual(["succeeded", "succeeded"]);
    const host1 = terminals().filter((t) => t.hostId === "host-1");
    expect(host1.every((t) => t.status === "failed")).toBe(true);
    // No run-level finalize on ordinary failures.
    expect(finalizePendingAttemptsMock).not.toHaveBeenCalled();
  });

  it("a PROVIDER rate-limit stops that host's remaining sessions (rate_limited) but not other hosts", async () => {
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) => {
      if (adapter.chatSessionId === "synth_run-1_host-1_0") {
        return {
          outcome: "rate_limited",
          errorMessage: "429 provider rate limit exceeded",
        };
      }
      return { outcome: "succeeded" };
    });

    await startJourneyRun(
      baseOpts({ hosts: [HOST, HOST_2], sessionsPerHost: 2 })
    );

    // host-1: only session 0 EXECUTED; session 1 short-circuited (never ran).
    expect(executedForHost("host-1")).toHaveLength(1);
    // host-2: both sessions still ran.
    expect(executedForHost("host-2")).toHaveLength(2);
    // host-1 sessions 0 AND 1 reach a rate_limited terminal (0 from its own
    // outcome, 1 from the remaining-attempt sweep).
    const host1RateLimited = reportAttemptMock.mock.calls
      .map((c) => c[2] as any)
      .filter((a) => a.hostId === "host-1" && a.status === "rate_limited")
      .map((a) => a.sessionIdx)
      .sort();
    expect(host1RateLimited).toEqual([0, 1]);
    // A provider rate-limit is per-host — no whole-run finalize.
    expect(finalizePendingAttemptsMock).not.toHaveBeenCalled();
  });

  it("an ORG spend-cap stops the whole run and finalizes pending attempts", async () => {
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) => {
      if (adapter.chatSessionId === "synth_run-1_host-1_0") {
        return {
          outcome: "rate_limited",
          errorMessage: "Org daily spend cap exceeded",
        };
      }
      return { outcome: "succeeded" };
    });

    await startJourneyRun(
      baseOpts({ hosts: [HOST, HOST_2], sessionsPerHost: 2 })
    );

    expect(finalizePendingAttemptsMock).toHaveBeenCalledTimes(1);
    const finalizeArgs = finalizePendingAttemptsMock.mock.calls[0]![2] as any;
    expect(finalizeArgs).toMatchObject({
      projectId: "proj-1",
      runId: "run-1",
      terminalStatus: "rate_limited",
      errorCode: "spend_cap_exceeded",
    });
  });

  it("an org cap phrased as 'quota exceeded' / 'budget exhausted' ALSO stops the whole run (finding 6)", async () => {
    for (const capMessage of ["quota exceeded", "monthly budget exhausted"]) {
      finalizePendingAttemptsMock.mockClear();
      runSyntheticHostSessionMock.mockImplementation(async (adapter: any) => {
        if (adapter.chatSessionId === "synth_run-1_host-1_0") {
          return { outcome: "rate_limited", errorMessage: capMessage };
        }
        return { outcome: "succeeded" };
      });

      await startJourneyRun(
        baseOpts({ hosts: [HOST, HOST_2], sessionsPerHost: 2 })
      );

      expect(
        finalizePendingAttemptsMock,
        `"${capMessage}" should trip the whole-run spend-cap stop`
      ).toHaveBeenCalledTimes(1);
      expect(finalizePendingAttemptsMock.mock.calls[0]![2]).toMatchObject({
        errorCode: "spend_cap_exceeded",
      });
    }
  });

  it("a 'capacity' rate-limit is a PER-HOST provider stop, NOT a whole-run spend-cap (finding 7)", async () => {
    // "capacity" must not be misread as a spend cap: only THIS host stops; the
    // run does not finalize-pending.
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) => {
      if (adapter.chatSessionId === "synth_run-1_host-1_0") {
        return {
          outcome: "rate_limited",
          errorMessage: "rate capacity exceeded",
        };
      }
      return { outcome: "succeeded" };
    });

    await startJourneyRun(
      baseOpts({ hosts: [HOST, HOST_2], sessionsPerHost: 2 })
    );

    // No whole-run finalize — it stayed a per-host provider rate-limit.
    expect(finalizePendingAttemptsMock).not.toHaveBeenCalled();
    // host-2 kept running to completion.
    expect(executedForHost("host-2")).toHaveLength(2);
    // host-1 short-circuited after session 0 (session 1 never executed).
    expect(executedForHost("host-1")).toHaveLength(1);
  });

  it("a throwing host worker (e.g. model-less spec) finalizes ITS attempts failed and does not abort the other hosts (finding 8)", async () => {
    // Force a worker-level throw for host-1 (a stand-in for a model-less pinned
    // spec whose modelId can't resolve). host-2's worker must keep running.
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) => {
      if (adapter.persist.hostId === "host-1") {
        throw new Error("model-less host: cannot resolve modelId");
      }
      return { outcome: "succeeded" };
    });

    await startJourneyRun(
      baseOpts({ hosts: [HOST, HOST_2], sessionsPerHost: 2 })
    );

    // The other host completed all its sessions — the pool was not aborted.
    expect(executedForHost("host-2")).toHaveLength(2);
    const host2Terminals = terminals().filter((t) => t.hostId === "host-2");
    expect(host2Terminals.map((t) => t.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);

    // The failing host's attempts are all finalized failed(host_worker_failed)
    // rather than left dangling.
    const host1Failed = reportAttemptMock.mock.calls
      .map((c) => c[2] as any)
      .filter(
        (a) =>
          a.hostId === "host-1" &&
          a.status === "failed" &&
          a.errorCode === "host_worker_failed"
      )
      .map((a) => a.sessionIdx)
      .sort();
    expect(host1Failed).toEqual([0, 1]);
  });
});

describe("swarm fan-out runner — spend-cap abort reclassification (finding 5)", () => {
  const HOST_3 = {
    hostId: "host-3",
    hostName: "Host Three",
    hostConfigId: "hc-3",
    modelId: "anthropic/claude-haiku-4.5",
    systemPrompt: "sys",
    requireToolApproval: false,
    serverIds: ["server-3"],
  };

  it("reports an in-flight session that the spend-cap abort cancelled as rate_limited/spend_cap_exceeded (NOT session_failed), while a genuinely-succeeded session keeps its outcome", async () => {
    // Concurrent barrier: host-1 trips the org spend cap while host-2 has a
    // session PARKED in-flight. The cap's `runStop.abort()` cancels host-2's
    // turns and the shared core returns `outcome: "failed"` — an abort artifact,
    // NOT a genuine failure. host-3 genuinely succeeds and must be untouched.
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) => {
      const hostId = adapter.persist.hostId;
      if (hostId === "host-1") {
        // Trip the org spend cap.
        return {
          outcome: "rate_limited",
          errorMessage: "Org daily spend cap exceeded",
        };
      }
      if (hostId === "host-3") {
        // Genuinely succeeds (before/independent of the cap).
        return { outcome: "succeeded" };
      }
      // host-2: park until the run-stop aborts this session, then return the
      // abort artifact the real core returns (`{ outcome: "failed" }`).
      return await new Promise((resolve) => {
        const finish = () => resolve({ outcome: "failed" });
        if (adapter.abortSignal?.aborted) {
          finish();
          return;
        }
        adapter.abortSignal?.addEventListener("abort", finish, { once: true });
      });
    });

    await startJourneyRun(
      baseOpts({ hosts: [HOST, HOST_2, HOST_3], sessionsPerHost: 1 })
    );

    const terminals = reportAttemptMock.mock.calls
      .map((c) => c[2] as any)
      .filter((a) => a.status !== "running");

    // host-2's aborted attempt: reported terminal rate_limited /
    // spend_cap_exceeded — NOT the generic session_failed.
    const host2 = terminals.find((t) => t.hostId === "host-2")!;
    expect(host2.status).toBe("rate_limited");
    expect(host2.errorCode).toBe("spend_cap_exceeded");
    expect(host2.errorCode).not.toBe("session_failed");
    // Persist-before-terminal invariant preserved: same deterministic id.
    expect(host2.chatSessionId).toBe("synth_run-1_host-2_0");

    // host-3's genuinely-succeeded session is untouched.
    const host3 = terminals.find((t) => t.hostId === "host-3")!;
    expect(host3.status).toBe("succeeded");

    // The whole-run finalize still runs for the spend-cap breach.
    expect(finalizePendingAttemptsMock).toHaveBeenCalledTimes(1);
    expect(finalizePendingAttemptsMock.mock.calls[0]![2]).toMatchObject({
      terminalStatus: "rate_limited",
      errorCode: "spend_cap_exceeded",
    });
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
