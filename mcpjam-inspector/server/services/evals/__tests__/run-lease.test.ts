import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import {
  EvalWorkerShutdownError,
  LeaseLostError,
  createRunLeaseDriver,
  evalResumeEnabled,
  isLeaseLostError,
  isSilentStop,
  iterationLeasesEnabled,
  leaseTokenArg,
  resetIterationLeasesForTests,
  startRunLeaseDriver,
} from "../run-lease";
import {
  registerActiveEvalRun,
  resetActiveEvalRunsForTests,
  shutdownActiveEvalRuns,
} from "../active-eval-runs";

const ON = { MCPJAM_EVAL_ITERATION_LEASES: "1" };
const HANDOFF = { MCPJAM_EVAL_SHUTDOWN_HANDOFF: "1" };

function convex(handlers: Record<string, (args: any) => unknown>) {
  return {
    mutation: vi.fn(async (name: string, args: any) => {
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected mutation ${name}`);
      return handler(args);
    }),
  };
}

afterEach(() => {
  resetIterationLeasesForTests();
  resetActiveEvalRunsForTests();
});

describe("flags and stop reasons", () => {
  it("leases and resume are off by default; resume needs leases", () => {
    expect(iterationLeasesEnabled({})).toBe(false);
    expect(iterationLeasesEnabled(ON)).toBe(true);
    expect(evalResumeEnabled({ EVAL_RESUME_ENABLED: "1" })).toBe(false);
    expect(evalResumeEnabled({ ...ON, EVAL_RESUME_ENABLED: "1" })).toBe(true);
  });

  it("recognises the backend fence in every shape a client sees it", () => {
    expect(isLeaseLostError(new LeaseLostError())).toBe(true);
    expect(
      isLeaseLostError(new ConvexError({ code: "LEASE_LOST", message: "x" })),
    ).toBe(true);
    expect(isLeaseLostError(new Error("Uncaught ConvexError: LEASE_LOST"))).toBe(
      true,
    );
    expect(isLeaseLostError(new Error("lease is fine"))).toBe(false);
    expect(isSilentStop(new EvalWorkerShutdownError())).toBe(true);
    expect(isSilentStop(new Error("cancelled"))).toBe(false);
  });
});

describe("startRunLeaseDriver", () => {
  it("returns nothing with the flag off — the run proceeds unleased", async () => {
    const client = convex({});
    expect(
      await startRunLeaseDriver({
        convexClient: client as any,
        runId: "run-1",
        abortRun: vi.fn(),
        env: {},
      }),
    ).toBeUndefined();
    expect(client.mutation).not.toHaveBeenCalled();
  });

  it("runs unleased when the backend refuses or predates the driver claim", async () => {
    const client = convex({
      "evalRunLeases:claimRunDriver": () => {
        throw new Error("Could not find public function");
      },
    });
    expect(
      await startRunLeaseDriver({
        convexClient: client as any,
        runId: "run-1",
        abortRun: vi.fn(),
        env: ON,
      }),
    ).toBeUndefined();
  });

  it("asks for resumability only with EVAL_RESUME_ENABLED, and reports the answer", async () => {
    const client = convex({
      "evalRunLeases:claimRunDriver": () => ({ ok: true, driverToken: "drv" }),
      "evalRunLeases:markEvalRunResumable": () => ({ resumable: true }),
    });
    const facts = {
      unitTimeoutMs: 1,
      executionDeadlineAt: 2,
      requestScopedKeys: false,
      harness: false,
    };
    const unleasedResume = await startRunLeaseDriver({
      convexClient: client as any,
      runId: "run-1",
      abortRun: vi.fn(),
      resumable: facts,
      env: ON,
    });
    expect(unleasedResume?.resumable).toBe(false);
    const driver = await startRunLeaseDriver({
      convexClient: client as any,
      runId: "run-1",
      abortRun: vi.fn(),
      resumable: facts,
      env: { ...ON, EVAL_RESUME_ENABLED: "1" },
    });
    expect(driver?.resumable).toBe(true);
    expect(client.mutation).toHaveBeenCalledWith(
      "evalRunLeases:markEvalRunResumable",
      { runId: "run-1", driverToken: "drv", ...facts },
    );
  });

  it("a resume adopts the claimed driver token without minting one", async () => {
    const client = convex({});
    const driver = await startRunLeaseDriver({
      convexClient: client as any,
      runId: "run-1",
      abortRun: vi.fn(),
      existingDriverToken: "drv-resume",
      env: ON,
    });
    expect(driver).toMatchObject({ driverToken: "drv-resume", resumable: true });
    expect(client.mutation).not.toHaveBeenCalled();
  });
});

describe("createRunLeaseDriver", () => {
  const make = (handlers: Record<string, (args: any) => unknown> = {}) => {
    const client = convex({
      "evalRunLeases:claimTestIteration": ({ iterationId }) => ({
        ok: true,
        leaseToken: `lease-${iterationId}`,
      }),
      "evalRunLeases:releaseTestIteration": () => ({ ok: true }),
      ...handlers,
    });
    const abortRun = vi.fn();
    const driver = createRunLeaseDriver({
      convexClient: client as any,
      runId: "run-1",
      driverToken: "drv",
      resumable: false,
      abortRun,
    });
    return { client, abortRun, driver };
  };

  it("a claim exposes the token to every write site until release", async () => {
    const { client, driver } = make();
    expect(await driver.claimIteration("it-1", 60_000)).toEqual({
      ok: true,
      leaseToken: "lease-it-1",
    });
    expect(client.mutation).toHaveBeenCalledWith(
      "evalRunLeases:claimTestIteration",
      { iterationId: "it-1", driverToken: "drv", unitTimeoutMs: 60_000 },
    );
    expect(leaseTokenArg("it-1")).toEqual({ leaseToken: "lease-it-1" });
    expect(driver.heartbeatArgs()).toEqual({
      driverToken: "drv",
      iterationTokens: [{ iterationId: "it-1", leaseToken: "lease-it-1" }],
    });
    await driver.releaseIteration("it-1");
    expect(client.mutation).toHaveBeenCalledWith(
      "evalRunLeases:releaseTestIteration",
      { iterationId: "it-1", leaseToken: "lease-it-1" },
    );
    expect(leaseTokenArg("it-1")).toEqual({});
    expect(driver.heartbeatArgs().iterationTokens).toEqual([]);
  });

  it("a refusal is reported; a failed claim CALL throws (never read as a refusal)", async () => {
    const refused = make({
      "evalRunLeases:claimTestIteration": () => ({ ok: false, reason: "lease_live" }),
    });
    expect(await refused.driver.claimIteration("it-1", 1)).toEqual({
      ok: false,
      reason: "lease_live",
    });
    const broken = make({
      "evalRunLeases:claimTestIteration": () => {
        throw new Error("convex down");
      },
    });
    await expect(broken.driver.claimIteration("it-1", 1)).rejects.toMatchObject({
      name: "IterationClaimFailedError",
      iterationId: "it-1",
    });
    expect(leaseTokenArg("it-1")).toEqual({});
  });

  it("a lost iteration aborts only that iteration and drops its token", async () => {
    const { driver, abortRun } = make();
    await driver.claimIteration("it-1", 1);
    await driver.claimIteration("it-2", 1);
    const lost1 = vi.fn();
    const lost2 = vi.fn();
    driver.onIterationLost("it-1", lost1);
    driver.onIterationLost("it-2", lost2);
    driver.applyHeartbeatResult({ driverSuperseded: false, lostIterationIds: ["it-1"] });
    expect(lost1).toHaveBeenCalledWith(expect.any(LeaseLostError));
    expect(lost2).not.toHaveBeenCalled();
    expect(abortRun).not.toHaveBeenCalled();
    expect(leaseTokenArg("it-1")).toEqual({});
    expect(leaseTokenArg("it-2")).toEqual({ leaseToken: "lease-it-2" });
  });

  it("a superseded driver stops the whole run and refuses further claims", async () => {
    const { driver, abortRun } = make();
    await driver.claimIteration("it-1", 1);
    const lost = vi.fn();
    driver.onIterationLost("it-1", lost);
    driver.applyHeartbeatResult({ driverSuperseded: true });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(abortRun).toHaveBeenCalledWith(expect.any(LeaseLostError));
    expect(await driver.claimIteration("it-2", 1)).toEqual({
      ok: false,
      reason: "superseded",
    });
  });
});

describe("shutdownActiveEvalRuns", () => {
  it("aborts every run silently, then hands resumable runs back and terminalizes the rest", async () => {
    const resumableClient = convex({
      "evalRunLeases:handBackEvalRun": () => ({ ok: true, requeued: 2 }),
    });
    const plainClient = convex({
      "evalRunLeases:terminalizeInterruptedRun": () => ({ ok: true, terminalized: 1 }),
    });
    const aborts: Error[] = [];
    const resumable = registerActiveEvalRun({
      runId: "run-r",
      suiteId: "s",
      convexClient: resumableClient as any,
      abort: (reason) => {
        aborts.push(reason);
        resumable.settle();
      },
      lease: () => ({ resumable: true, driverToken: "drv-r" }) as any,
    });
    const plain = registerActiveEvalRun({
      runId: "run-p",
      suiteId: "s",
      convexClient: plainClient as any,
      abort: (reason) => {
        aborts.push(reason);
        plain.settle();
      },
    });

    const summary = await shutdownActiveEvalRuns({
      graceMs: 1_000,
      callTimeoutMs: 1_000,
      env: HANDOFF,
    });
    expect(summary).toEqual({ runs: 2, handedBack: 1, terminalized: 1, unresolved: 0 });
    expect(aborts).toHaveLength(2);
    expect(aborts.every((reason) => reason instanceof EvalWorkerShutdownError)).toBe(
      true,
    );
    expect(resumableClient.mutation).toHaveBeenCalledWith(
      "evalRunLeases:handBackEvalRun",
      { runId: "run-r", driverToken: "drv-r", reason: "worker_shutdown" },
    );
    expect(plainClient.mutation).toHaveBeenCalledWith(
      "evalRunLeases:terminalizeInterruptedRun",
      { runId: "run-p", reason: "worker_shutdown" },
    );
  });

  it("is bounded: a run that never settles and a backend that never answers are left to the watchdog", async () => {
    const hung = { mutation: vi.fn(() => new Promise(() => {})) };
    registerActiveEvalRun({
      runId: "run-h",
      suiteId: "s",
      convexClient: hung as any,
      abort: () => {},
    });
    const started = Date.now();
    const summary = await shutdownActiveEvalRuns({
      graceMs: 20,
      callTimeoutMs: 20,
      env: HANDOFF,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(summary).toMatchObject({ runs: 1, unresolved: 1 });
  });

  it("off by default: runs are left alone (legacy: the watchdog converges them)", async () => {
    const abort = vi.fn();
    registerActiveEvalRun({
      runId: "run-k",
      suiteId: "s",
      convexClient: convex({}) as any,
      abort,
    });
    const summary = await shutdownActiveEvalRuns({ env: {} });
    expect(abort).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ runs: 1, unresolved: 1 });
  });

  it("a run that registers during shutdown is stopped at once", async () => {
    await shutdownActiveEvalRuns({ graceMs: 1, callTimeoutMs: 1, env: HANDOFF });
    const abort = vi.fn();
    registerActiveEvalRun({
      runId: "late",
      suiteId: "s",
      convexClient: convex({}) as any,
      abort,
    });
    expect(abort).toHaveBeenCalledWith(expect.any(EvalWorkerShutdownError));
  });
});
