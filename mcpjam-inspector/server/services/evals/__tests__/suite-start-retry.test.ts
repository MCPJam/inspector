import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { startSuiteRunWithRecorder } from "../recorder.js";

const conflict = () =>
  new Error(
    'Documents read from or written to the "evalIterationStarterAllotments" table changed while this mutation was being run and on every subsequent retry.',
  );

describe("suite launch conflict recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries only the start call with identical arguments and prepares iterations once", async () => {
    const mutation = vi
      .fn()
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(new Error("OptimisticConcurrencyControlFailure"))
      .mockResolvedValue({ runId: "run-1", testCases: [] });
    const action = vi.fn().mockResolvedValue({ iterationIds: [] });
    const result = startSuiteRunWithRecorder({
      convexClient: { mutation, action } as any,
      suiteId: "suite-1",
      idempotencyKey: "stable-key",
      iterationOverride: 10,
    });
    await vi.advanceTimersByTimeAsync(124);
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mutation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    await result;
    expect(mutation).toHaveBeenCalledTimes(3);
    for (const [name, args] of mutation.mock.calls) {
      expect(name).toBe("testSuites:startTestSuiteRun");
      expect(args).toBe(mutation.mock.calls[0][1]);
      expect(args).toMatchObject({
        idempotencyKey: "stable-key",
        iterationOverride: 10,
      });
    }
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith("testSuites:startSuiteRunIterations", {
      runId: "run-1",
    });
  });

  it("stops after four conflicts without preparing or cleaning up a nonexistent run", async () => {
    const error = conflict();
    const mutation = vi.fn().mockRejectedValue(error);
    const action = vi.fn();
    const result = startSuiteRunWithRecorder({
      convexClient: { mutation, action } as any,
      suiteId: "suite-1",
    });
    const rejected = expect(result).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await rejected;
    expect(mutation).toHaveBeenCalledTimes(4);
    expect(action).not.toHaveBeenCalled();
  });

  it.each([
    new Error("fetch failed"),
    new Error("Unauthorized"),
    new ConvexError({
      code: "billing_limit_reached",
      message: "Iteration limit reached",
    }),
    new ConvexError({
      code: "invalid_input",
      message: "OptimisticConcurrencyControlFailure",
    }),
  ])("does not retry a refusal or ambiguous failure: %s", async (error) => {
    const mutation = vi.fn().mockRejectedValue(error);
    const action = vi.fn();
    await expect(
      startSuiteRunWithRecorder({
        convexClient: { mutation, action } as any,
        suiteId: "suite-1",
      }),
    ).rejects.toBeDefined();
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps five concurrent client launches separate after conflicts", async () => {
    const attempts = new Map<string, number>();
    const mutation = vi.fn(async (_name, args) => {
      const count = (attempts.get(args.idempotencyKey) ?? 0) + 1;
      attempts.set(args.idempotencyKey, count);
      if (count === 1) throw conflict();
      return {
        runId: args.idempotencyKey,
        testCases: Array.from({ length: 20 }, (_, i) => ({
          _id: `case-${i}`,
          runs: 10,
        })),
      };
    });
    const action = vi.fn().mockResolvedValue({ iterationIds: [] });
    const runs = Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        startSuiteRunWithRecorder({
          convexClient: { mutation, action } as any,
          suiteId: "suite-1",
          idempotencyKey: `client-${i}`,
          iterationOverride: 10,
        }),
      ),
    );
    await vi.runAllTimersAsync();
    await runs;
    expect(mutation).toHaveBeenCalledTimes(10);
    expect(action).toHaveBeenCalledTimes(5);
    expect(new Set(action.mock.calls.map(([, args]) => args.runId)).size).toBe(
      5,
    );
  });
});
