/**
 * swarm-runner.sponsored.test.ts: how the fan-out runner honours the backend's
 * per-conversation funding.
 *
 * Same seam as `swarm-runner.test.ts`: the shared host-session core and the
 * backend client are stubbed, so these tests pin the runner's own contract:
 * which conversations carry the sponsored claim, and how a spend cap or a
 * platform limit stops one funding scope without stopping the other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setupTurnMock = vi.fn();
const reportTargetGroundingMock = vi.fn();
const reportAttemptMock = vi.fn();
vi.mock("../swarm-setup-turn", async () => ({
  ...(await vi.importActual<typeof import("../swarm-setup-turn")>(
    "../swarm-setup-turn",
  )),
  runSwarmSetupTurn: (...args: unknown[]) => setupTurnMock(...args),
}));
const swarmPersonaNextTurnMock = vi.fn();
const heartbeatJourneyRunMock = vi.fn();
const runSyntheticHostSessionMock = vi.fn();
const finalizePendingAttemptsMock = vi.fn();

vi.mock("../../swarm-agent.js", async () => {
  const actual = await vi.importActual<typeof import("../../swarm-agent.js")>(
    "../../swarm-agent.js",
  );
  return {
    ...actual,
    reportTargetGrounding: (...args: unknown[]) =>
      reportTargetGroundingMock(...args),
    reportAttempt: (...args: unknown[]) => reportAttemptMock(...args),
    swarmPersonaNextTurn: (...args: unknown[]) =>
      swarmPersonaNextTurnMock(...args),
    heartbeatJourneyRun: (...args: unknown[]) =>
      heartbeatJourneyRunMock(...args),
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
    captureAndPersistWidgetSnapshotsForSession: vi.fn(),
  };
});

import { startJourneyRun } from "../swarm-runner.js";
import { SwarmSetupError } from "../swarm-setup-turn.js";
import {
  SPONSORED_CAPACITY_MESSAGE,
  type SwarmSessionFunding,
} from "../../../../shared/swarm-sponsorship.js";

const target = (name: string) => ({
  hostId: `host-${name}`,
  hostName: `Host ${name}`,
  hostConfigId: `hc-${name}`,
  targetId: `target-${name}`,
  modelId: "anthropic/claude-haiku-4.5",
  systemPrompt: "sys",
  requireToolApproval: false,
  serverIds: [`server-${name}`],
});
const A = target("a");
const B = target("b");

const funding = (
  targetId: string,
  ...values: Array<"starter" | "credits">
): SwarmSessionFunding[] =>
  values.map((value, sessionIdx) => ({
    targetId,
    sessionIdx,
    funding: value,
  }));

function opts(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    projectId: "proj-1",
    hosts: [A],
    personaSnapshot: {
      personaId: "p1",
      name: "Persona",
      role: "tester",
      notes: "",
    },
    sessionsPerTarget: 2,
    maxTurns: 3,
    convexHttpUrl: "https://convex.site",
    getBearer: async () => "token",
    managerFactory: async () => ({
      manager: {} as never,
      connectedServerIds: ["server-1"],
      dispose: async () => {},
    }),
    ...overrides,
  };
}

const terminals = () =>
  reportAttemptMock.mock.calls
    .map((call) => call[2] as any)
    .filter((args) => args.status !== "running");
const claimed = () =>
  reportAttemptMock.mock.calls
    .map((call) => call[2] as any)
    .filter((args) => args.status === "running");
const READY_SETUP = {
  status: "completed",
  readiness: "not_needed",
  createdEntities: [],
  toolCalls: [],
  writeCallsDispatched: 0,
  admittedWriteTools: [],
  missing: [],
  unsupportedClaims: 0,
  observedCreatedEntityCount: 0,
  excludedToolCount: 0,
  prefix: "p-",
  retried: false,
  startedAt: 0,
  durationMs: 0,
  chatSessionId: "setup",
};

const SPEND_CAP = "Org daily spend cap exceeded";

beforeEach(() => {
  setupTurnMock.mockReset();
  reportTargetGroundingMock.mockReset().mockResolvedValue({});
  reportAttemptMock.mockReset().mockResolvedValue({ ok: true, applied: true });
  swarmPersonaNextTurnMock
    .mockReset()
    .mockResolvedValue({ message: "hi", endSession: false });
  heartbeatJourneyRunMock.mockReset().mockResolvedValue(undefined);
  finalizePendingAttemptsMock.mockReset().mockResolvedValue(undefined);
  runSyntheticHostSessionMock
    .mockReset()
    .mockResolvedValue({ outcome: "succeeded" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("sponsored swarm conversations: routing by funding", () => {
  it("attaches the sponsored claim identity only to conversations the backend funded as starter", async () => {
    await startJourneyRun(
      opts({
        sessionFunding: funding(A.targetId, "starter", "credits"),
      }) as never,
    );

    const adapters = runSyntheticHostSessionMock.mock.calls.map(
      (call) => call[0] as any,
    );
    expect(adapters).toHaveLength(2);
    expect(adapters[0].runtime.sponsorship).toEqual({
      targetId: "target-a",
      sessionIdx: 0,
    });
    expect(adapters[1].runtime.sponsorship).toBeUndefined();
  });

  it("sends the service-token proof on persona calls of sponsored conversations only", async () => {
    await startJourneyRun(
      opts({
        sessionFunding: funding(A.targetId, "starter", "credits"),
      }) as never,
    );

    for (const call of runSyntheticHostSessionMock.mock.calls) {
      await (call[0] as any).nextPersonaTurn([]);
    }
    const personaArgs = swarmPersonaNextTurnMock.mock.calls.map(
      (call) => call[2] as any,
    );
    expect(personaArgs[0]).toMatchObject({ sessionIdx: 0, sponsored: true });
    expect(personaArgs[1].sponsored).toBeUndefined();
  });

  it("treats every conversation as credit-funded when the backend reported no funding", async () => {
    await startJourneyRun(opts() as never);

    for (const call of runSyntheticHostSessionMock.mock.calls) {
      expect((call[0] as any).runtime.sponsorship).toBeUndefined();
    }
    expect(terminals().map((t) => t.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
  });

  it("makes target setup and grounding sponsored when any conversation of the target is", async () => {
    setupTurnMock.mockResolvedValue(READY_SETUP);
    await startJourneyRun(
      opts({
        hosts: [A, B],
        setupWrites: true,
        sessionsPerTarget: 1,
        sessionFunding: [
          ...funding(A.targetId, "starter"),
          ...funding(B.targetId, "credits"),
        ],
      }) as never,
    );

    const setupByTarget = new Map(
      setupTurnMock.mock.calls.map((call) => [
        (call[0] as any).target.targetId,
        (call[0] as any).sponsored,
      ]),
    );
    expect(setupByTarget.get("target-a")).toBe(true);
    expect(setupByTarget.get("target-b")).toBeFalsy();
  });
});

describe("sponsored swarm conversations: the org spend cap is scoped to credit-funded conversations", () => {
  // Target A's credit conversation trips the org cap while target B's
  // sponsored conversation is in flight; B must finish and run its next one.
  function parkSponsoredUntilCapTrips() {
    let tripped!: () => void;
    const capTripped = new Promise<void>((resolve) => (tripped = resolve));
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) => {
      if (adapter.persist.targetId === "target-a") {
        tripped();
        return { outcome: "rate_limited", errorMessage: SPEND_CAP };
      }
      if (adapter.chatSessionId.endsWith("_0")) {
        await capTripped;
        // Give the runner time to act on the trip before B resumes.
        await new Promise((resolve) => setTimeout(resolve, 20));
        // What the real core returns for a session the run-level stop cut off.
        if (adapter.abortSignal?.aborted) return { outcome: "failed" };
      }
      return { outcome: "succeeded" };
    });
  }

  it("stops credit-funded conversations and lets sponsored ones in the same run continue", async () => {
    parkSponsoredUntilCapTrips();
    const signals: boolean[] = [];
    const original = runSyntheticHostSessionMock.getMockImplementation()!;
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) => {
      const result = await original(adapter);
      if (adapter.persist.targetId === "target-b") {
        signals.push(adapter.abortSignal.aborted);
      }
      return result;
    });

    await startJourneyRun(
      opts({
        hosts: [A, B],
        sessionsPerTarget: 2,
        sessionFunding: [
          ...funding(A.targetId, "credits", "credits"),
          ...funding(B.targetId, "starter", "starter"),
        ],
      }) as never,
    );

    // Both sponsored conversations ran to a succeeded terminal, unaborted.
    expect(
      terminals().filter(
        (t) => t.targetId === "target-b" && t.status === "succeeded",
      ),
    ).toHaveLength(2);
    expect(signals).toEqual([false, false]);
    // The credit-funded conversation that tripped the cap is rate limited, and
    // the second one never started; the run-level sweep closes it.
    expect(claimed().filter((c) => c.targetId === "target-a")).toHaveLength(1);
    expect(finalizePendingAttemptsMock).toHaveBeenCalledTimes(1);
    expect(finalizePendingAttemptsMock.mock.calls[0]![2]).toMatchObject({
      terminalStatus: "rate_limited",
      errorCode: "spend_cap_exceeded",
      // The sweep must not touch sponsored attempts.
      fundingScope: "credits",
    });
  });

  it("keeps a sponsored conversation of the SAME target running after its credit sibling trips the cap", async () => {
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) =>
      adapter.chatSessionId.endsWith("_0")
        ? { outcome: "rate_limited", errorMessage: SPEND_CAP }
        : { outcome: "succeeded" },
    );

    // Mixed target: index 0 is credit-funded (trips), index 1 is sponsored.
    await startJourneyRun(
      opts({
        sessionsPerTarget: 2,
        sessionFunding: funding(A.targetId, "credits", "starter"),
      }) as never,
    );

    expect(terminals().map((t) => `${t.sessionIdx}:${t.status}`)).toEqual([
      "0:rate_limited",
      "1:succeeded",
    ]);
  });

  it("still stops the whole run when no conversation in it is sponsored", async () => {
    parkSponsoredUntilCapTrips();

    await startJourneyRun(
      opts({
        hosts: [A, B],
        sessionsPerTarget: 2,
        // Old backend semantics: nothing sponsored anywhere.
        sessionFunding: [
          ...funding(A.targetId, "credits", "credits"),
          ...funding(B.targetId, "credits", "credits"),
        ],
      }) as never,
    );

    // B's second conversation never started; B's parked first one was aborted
    // by the run-level stop and reported as the spend cap, not as a success.
    expect(claimed().filter((c) => c.targetId === "target-b")).toHaveLength(1);
    expect(terminals().find((t) => t.targetId === "target-b")).toMatchObject({
      status: "rate_limited",
      errorCode: "spend_cap_exceeded",
    });
    expect(finalizePendingAttemptsMock.mock.calls[0]![2]).toMatchObject({
      errorCode: "spend_cap_exceeded",
    });
    // Nothing sponsored, so the sweep is the whole run's, as it always was.
    expect(finalizePendingAttemptsMock.mock.calls[0]![2]).not.toHaveProperty(
      "fundingScope",
    );
  });

  it("closes credit-funded and sponsored leftovers separately when a spend cap and a platform limit both hit", async () => {
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) =>
      adapter.runtime.sponsorship
        ? {
            outcome: "failed",
            errorMessage: SPONSORED_CAPACITY_MESSAGE,
            errorReason: "platform_capacity",
          }
        : { outcome: "rate_limited", errorMessage: SPEND_CAP },
    );

    await startJourneyRun(
      opts({
        hosts: [A, B],
        sessionsPerTarget: 2,
        sessionFunding: [
          ...funding(A.targetId, "credits", "credits"),
          ...funding(B.targetId, "starter", "starter"),
        ],
      }) as never,
    );

    const calls = finalizePendingAttemptsMock.mock.calls.map((c) => c[2]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      errorCode: "spend_cap_exceeded",
      fundingScope: "credits",
    });
    // The platform stop closes the SPONSORED leftovers. The credit-funded ones
    // already had their own sweep above, and a credit-funded attempt left
    // behind by a failed claim or terminal write must not be closed with the
    // sponsored reason (the stale-run sweep backstops it, as before).
    expect(calls[1]).toMatchObject({
      terminalStatus: "failed",
      errorCode: "platform_capacity",
      fundingScope: "sponsored",
    });
  });
});

describe("sponsored swarm conversations: a provider rate limit still stops the target", () => {
  it("stops a target's later sponsored conversations after its provider throttles one, without claiming them", async () => {
    runSyntheticHostSessionMock.mockResolvedValue({
      outcome: "rate_limited",
      errorMessage: "429 Too Many Requests from the model provider",
    });

    await startJourneyRun(
      opts({
        sessionsPerTarget: 3,
        sessionFunding: funding(A.targetId, "starter", "starter", "starter"),
      }) as never,
    );

    // Only the first conversation ran; the others were never claimed (a claim
    // would count as execution) instead of hammering the throttled provider.
    expect(claimed()).toHaveLength(1);
    expect(runSyntheticHostSessionMock).toHaveBeenCalledTimes(1);
    expect(terminals().map((t) => `${t.sessionIdx}:${t.status}`)).toEqual([
      "0:rate_limited",
    ]);
    // They are closed through the backend's terminal path, scoped to this
    // target's sponsored conversations, so their slots go back and the run
    // does not wait for the stale-run sweep.
    expect(finalizePendingAttemptsMock).toHaveBeenCalledTimes(1);
    expect(finalizePendingAttemptsMock.mock.calls[0]![2]).toMatchObject({
      runId: "run-1",
      terminalStatus: "rate_limited",
      errorCode: "rate_limited",
      fundingScope: "sponsored",
      targetId: "target-a",
    });
  });

  it("closes only the sponsored remainder when a credit-funded conversation is the one throttled", async () => {
    runSyntheticHostSessionMock.mockResolvedValue({
      outcome: "rate_limited",
      errorMessage: "429 Too Many Requests from the model provider",
    });

    await startJourneyRun(
      opts({
        sessionsPerTarget: 3,
        sessionFunding: funding(A.targetId, "credits", "starter", "starter"),
      }) as never,
    );

    // The credit-funded conversation is the only one claimed. The sponsored
    // ones are closed by one scoped call, never by claiming them.
    expect(claimed().map((c) => c.sessionIdx)).toEqual([0]);
    expect(finalizePendingAttemptsMock).toHaveBeenCalledTimes(1);
    expect(finalizePendingAttemptsMock.mock.calls[0]![2]).toMatchObject({
      fundingScope: "sponsored",
      targetId: "target-a",
    });
  });

  it("does not call the scoped close for a target with no sponsored conversations", async () => {
    runSyntheticHostSessionMock.mockResolvedValue({
      outcome: "rate_limited",
      errorMessage: "429 Too Many Requests from the model provider",
    });

    await startJourneyRun(
      opts({
        sessionsPerTarget: 3,
        sessionFunding: funding(A.targetId, "credits", "credits", "credits"),
      }) as never,
    );

    expect(
      finalizePendingAttemptsMock.mock.calls.some(
        (call) => call[2].fundingScope === "sponsored",
      ),
    ).toBe(false);
  });
});

describe("sponsored swarm conversations: a failure before any conversation starts never spends the allowance", () => {
  const missingPrerequisites = () =>
    new SwarmSetupError({
      status: "failed",
      readiness: "unavailable",
      reason: "transport_failed",
    } as never);

  it("closes every sponsored conversation of a target whose setup failed without claiming any of them", async () => {
    setupTurnMock.mockRejectedValue(missingPrerequisites());

    await startJourneyRun(
      opts({
        setupWrites: true,
        sessionsPerTarget: 3,
        sessionFunding: funding(A.targetId, "starter", "starter", "starter"),
      }) as never,
    );

    // Nothing ran, so nothing may look like it started: a `running` claim is
    // what the backend counts as execution, and it would keep all three units.
    expect(runSyntheticHostSessionMock).not.toHaveBeenCalled();
    expect(claimed()).toHaveLength(0);
    expect(finalizePendingAttemptsMock).toHaveBeenCalledTimes(1);
    expect(finalizePendingAttemptsMock.mock.calls[0]![2]).toMatchObject({
      runId: "run-1",
      terminalStatus: "failed",
      errorCode: "prerequisites_unavailable",
      fundingScope: "sponsored",
      targetId: "target-a",
    });
  });

  it("still fails the credit-funded conversation of a mixed target the ordinary way", async () => {
    setupTurnMock.mockRejectedValue(missingPrerequisites());

    await startJourneyRun(
      opts({
        setupWrites: true,
        sessionsPerTarget: 3,
        sessionFunding: funding(A.targetId, "credits", "starter", "starter"),
      }) as never,
    );

    // Only the credit-funded conversation is claimed and failed by the runner.
    expect(claimed().map((c) => c.sessionIdx)).toEqual([0]);
    expect(terminals().map((t) => `${t.sessionIdx}:${t.errorCode}`)).toEqual([
      "0:prerequisites_unavailable",
    ]);
    expect(finalizePendingAttemptsMock).toHaveBeenCalledTimes(1);
    expect(finalizePendingAttemptsMock.mock.calls[0]![2]).toMatchObject({
      fundingScope: "sponsored",
      targetId: "target-a",
      errorCode: "prerequisites_unavailable",
    });
  });

  it("gives an unexpected worker failure the same treatment, with its own reason", async () => {
    setupTurnMock.mockRejectedValue(new Error("pinned skill could not load"));

    await startJourneyRun(
      opts({
        setupWrites: true,
        sessionsPerTarget: 2,
        sessionFunding: funding(A.targetId, "starter", "starter"),
      }) as never,
    );

    expect(claimed()).toHaveLength(0);
    expect(finalizePendingAttemptsMock).toHaveBeenCalledTimes(1);
    expect(finalizePendingAttemptsMock.mock.calls[0]![2]).toMatchObject({
      terminalStatus: "failed",
      errorCode: "host_worker_failed",
      fundingScope: "sponsored",
      targetId: "target-a",
    });
  });

  it("leaves a target with no sponsored conversations exactly as before", async () => {
    setupTurnMock.mockRejectedValue(missingPrerequisites());

    await startJourneyRun(
      opts({
        setupWrites: true,
        sessionsPerTarget: 2,
        sessionFunding: [],
      }) as never,
    );

    expect(claimed().map((c) => c.sessionIdx)).toEqual([0, 1]);
    expect(finalizePendingAttemptsMock).not.toHaveBeenCalled();
  });
});

describe("sponsored swarm conversations: platform capacity is the platform's problem", () => {
  const capacityFailure = {
    outcome: "failed",
    errorMessage: SPONSORED_CAPACITY_MESSAGE,
    errorReason: "platform_capacity",
  };

  it("ends the sponsored conversation as failed with a platform_capacity code, never as an org spend cap", async () => {
    runSyntheticHostSessionMock.mockResolvedValue(capacityFailure);

    await startJourneyRun(
      opts({
        sessionsPerTarget: 2,
        sessionFunding: funding(A.targetId, "starter", "starter"),
      }) as never,
    );

    expect(terminals()).toHaveLength(1);
    expect(terminals()[0]).toMatchObject({
      sessionIdx: 0,
      status: "failed",
      errorCode: "platform_capacity",
      errorMessage: SPONSORED_CAPACITY_MESSAGE,
    });
    // The raw wire form must not be mistaken for an org cap either.
    expect(
      finalizePendingAttemptsMock.mock.calls.some(
        (call) => call[2].errorCode === "spend_cap_exceeded",
      ),
    ).toBe(false);
  });

  it("does not start later sponsored conversations, and closes them in one sweep without claiming them", async () => {
    runSyntheticHostSessionMock.mockResolvedValue(capacityFailure);

    await startJourneyRun(
      opts({
        sessionsPerTarget: 3,
        sessionFunding: funding(A.targetId, "starter", "starter", "starter"),
      }) as never,
    );

    expect(runSyntheticHostSessionMock).toHaveBeenCalledTimes(1);
    expect(claimed()).toHaveLength(1);
    expect(finalizePendingAttemptsMock).toHaveBeenCalledTimes(1);
    expect(finalizePendingAttemptsMock.mock.calls[0]![2]).toMatchObject({
      terminalStatus: "failed",
      errorCode: "platform_capacity",
      errorMessage: SPONSORED_CAPACITY_MESSAGE,
      // Sponsored only: this sweep must not relabel a credit-funded leftover.
      fundingScope: "sponsored",
    });
  });

  // The sponsored scope belongs to the platform-stop sweep alone. A shutdown
  // that lands with the platform stop is the run's terminal, and sweeps
  // whatever is left whoever funded it.
  it("still sweeps everything on a shutdown that coincides with the platform stop", async () => {
    const controller = new AbortController();
    runSyntheticHostSessionMock.mockImplementation(async () => {
      controller.abort();
      return capacityFailure;
    });

    await startJourneyRun(
      opts({
        sessionsPerTarget: 3,
        sessionFunding: funding(A.targetId, "starter", "starter", "starter"),
        abortSignal: controller.signal,
      }) as never,
    );

    const sweeps = finalizePendingAttemptsMock.mock.calls.map((c) => c[2]);
    expect(sweeps.some((args) => args.errorCode === "runner_shutdown")).toBe(
      true,
    );
    for (const args of sweeps) {
      if (args.errorCode === "runner_shutdown") {
        expect(args).not.toHaveProperty("fundingScope");
      }
    }
  });

  // The run's clock is a run terminal like a shutdown, and it outranks the
  // platform stop: it sweeps whatever is left whoever funded it, so it carries no
  // scope. Scoped to sponsored, it would leave a credit-funded attempt that never
  // started pending until the backend's stale-run cron.
  it("still sweeps everything when the run clock cuts off a credit-funded conversation after the platform stop", async () => {
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) => {
      if (adapter.runtime.sponsorship) return capacityFailure;
      // A credit-funded conversation still running when the run's clock fires.
      // The real core reports a session it cut off as failed.
      await new Promise<void>((resolve) => {
        if (adapter.abortSignal.aborted) return resolve();
        adapter.abortSignal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      return { outcome: "failed" };
    });

    await startJourneyRun(
      opts({
        hosts: [A, B],
        sessionsPerTarget: 2,
        sessionFunding: [
          ...funding(A.targetId, "starter", "starter"),
          ...funding(B.targetId, "credits", "credits"),
        ],
        budgets: {
          turnTimeoutMs: 5 * 60_000,
          unitTimeoutMs: 20 * 60_000,
          // Short enough to fire while the credit-funded conversation is parked.
          runTimeoutMs: 50,
          turnRetries: 2,
          sources: {
            turnTimeoutMs: "default",
            unitTimeoutMs: "default",
            runTimeoutMs: "default",
            turnRetries: "default",
          },
        },
      }) as never,
    );

    // One conversation per target started; the second of each never did.
    expect(runSyntheticHostSessionMock).toHaveBeenCalledTimes(2);
    const sweeps = finalizePendingAttemptsMock.mock.calls.map((c) => c[2]);
    expect(sweeps.map((args) => args.errorCode)).toEqual(["run_timeout"]);
    expect(sweeps[0]).not.toHaveProperty("fundingScope");
  });

  it("does not stop credit-funded conversations in the same run", async () => {
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) =>
      adapter.runtime.sponsorship ? capacityFailure : { outcome: "succeeded" },
    );

    await startJourneyRun(
      opts({
        hosts: [A, B],
        sessionsPerTarget: 2,
        sessionFunding: [
          ...funding(A.targetId, "starter", "starter"),
          ...funding(B.targetId, "credits", "credits"),
        ],
      }) as never,
    );

    expect(
      terminals().filter(
        (t) => t.targetId === "target-b" && t.status === "succeeded",
      ),
    ).toHaveLength(2);
  });

  it("ends the credit-funded conversations of a mixed target skipped after a platform stop as missing prerequisites", async () => {
    // Three targets fill the worker pool; the fourth (a mixed target whose
    // setup is platform-paid) is pulled only after target B has hit the stop.
    const C = target("c");
    const D = target("d");
    setupTurnMock.mockResolvedValue(READY_SETUP);
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) =>
      adapter.persist.targetId === "target-b"
        ? capacityFailure
        : { outcome: "succeeded" },
    );

    await startJourneyRun(
      opts({
        hosts: [B, C, D, A],
        setupWrites: true,
        sessionsPerTarget: 2,
        sessionFunding: [
          ...funding(B.targetId, "starter", "starter"),
          ...funding(C.targetId, "credits", "credits"),
          ...funding(D.targetId, "credits", "credits"),
          ...funding(A.targetId, "starter", "credits"),
        ],
      }) as never,
    );

    // A was skipped: its platform-paid setup never ran and nothing was claimed.
    expect(
      setupTurnMock.mock.calls.some(
        (call: any) => call[0].target.targetId === "target-a",
      ),
    ).toBe(false);
    expect(claimed().some((c) => c.targetId === "target-a")).toBe(false);
    // A's credit-funded conversation cannot run without that setup, so it is
    // closed for what it is, by a credits-scoped call for that target. Its
    // sponsored one is left for the run-level sweep, which is a platform stop.
    const forA = finalizePendingAttemptsMock.mock.calls
      .map((call) => call[2])
      .filter((args) => args.targetId === "target-a");
    expect(forA).toHaveLength(1);
    expect(forA[0]).toMatchObject({
      fundingScope: "credits",
      terminalStatus: "failed",
      errorCode: "prerequisites_unavailable",
    });
    expect(
      finalizePendingAttemptsMock.mock.calls.some(
        (call) =>
          call[2].targetId === undefined &&
          call[2].errorCode === "platform_capacity",
      ),
    ).toBe(true);
  });

  it("classifies the raw wire form of a platform limit on a sponsored conversation as a platform stop", async () => {
    runSyntheticHostSessionMock.mockImplementation(async (adapter: any) =>
      adapter.runtime.sponsorship
        ? {
            outcome: "rate_limited",
            errorMessage:
              "MCPJam platform capacity is exhausted (platform_capacity, HTTP 429)",
          }
        : { outcome: "succeeded" },
    );

    await startJourneyRun(
      opts({
        hosts: [A, B],
        sessionsPerTarget: 1,
        sessionFunding: [
          ...funding(A.targetId, "starter"),
          ...funding(B.targetId, "credits"),
        ],
      }) as never,
    );

    // B is credit-funded and still runs: the platform limit did not become a
    // whole-run stop.
    expect(runSyntheticHostSessionMock).toHaveBeenCalledTimes(2);
    expect(
      finalizePendingAttemptsMock.mock.calls.some(
        (call) => call[2].errorCode === "spend_cap_exceeded",
      ),
    ).toBe(false);
  });

  it("keeps platform_capacity a whole-run stop for credit-funded conversations, as before", async () => {
    runSyntheticHostSessionMock.mockResolvedValue({
      outcome: "rate_limited",
      errorMessage: "capacity exhausted (platform_capacity, HTTP 429)",
    });

    await startJourneyRun(
      opts({ sessionsPerTarget: 2, sessionFunding: [] }) as never,
    );

    expect(runSyntheticHostSessionMock).toHaveBeenCalledTimes(1);
    expect(finalizePendingAttemptsMock.mock.calls[0]![2]).toMatchObject({
      errorCode: "spend_cap_exceeded",
    });
  });

  it("ends a target whose sponsored setup the platform refused as a platform problem, not missing prerequisites", async () => {
    setupTurnMock.mockImplementation(async ({ target }: any) => {
      if (target.targetId !== "target-a") return READY_SETUP;
      throw new SwarmSetupError(
        {
          status: "failed",
          readiness: "unavailable",
          reason: "transport_failed",
        } as never,
        {
          code: "platform_capacity",
          message: SPONSORED_CAPACITY_MESSAGE,
        },
      );
    });

    await startJourneyRun(
      opts({
        hosts: [A, B],
        setupWrites: true,
        sessionsPerTarget: 2,
        sessionFunding: [
          ...funding(A.targetId, "starter", "credits"),
          ...funding(B.targetId, "credits", "credits"),
        ],
      }) as never,
    );

    // A platform refusal is not closed per target: the run-level sweep closes
    // it as a platform stop.
    expect(
      finalizePendingAttemptsMock.mock.calls.some(
        (call) => call[2].targetId !== undefined,
      ),
    ).toBe(false);
    // A's sponsored attempt is left unclaimed (so it is refunded) and swept as
    // a platform stop; A's credit attempt fails as missing prerequisites.
    const aClaims = claimed().filter((c) => c.targetId === "target-a");
    expect(aClaims.map((c) => c.sessionIdx)).toEqual([1]);
    expect(
      terminals().find((t) => t.targetId === "target-a" && t.sessionIdx === 1),
    ).toMatchObject({
      status: "failed",
      errorCode: "prerequisites_unavailable",
    });
    expect(finalizePendingAttemptsMock.mock.calls[0]![2]).toMatchObject({
      terminalStatus: "failed",
      errorCode: "platform_capacity",
    });
    // Only the credit-funded target B ran; A never reached a session.
    const ran = runSyntheticHostSessionMock.mock.calls.map(
      (call) => (call[0] as any).persist.targetId,
    );
    expect(ran).toEqual(["target-b", "target-b"]);
  });
});
