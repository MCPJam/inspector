/**
 * Production checks worker — loop behavior and the evaluation of one claim.
 *
 * The loop tests mirror `scheduled-evals-worker.test.ts` (same seams). The
 * evaluation tests drive `executeClaimedCheck` against a mocked service
 * fetch and assert what lands on /complete and /fail — the wire is the
 * contract, and reason strings are the evidence the panel renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeClaimedCheck,
  startProductionChecksWorker,
  type ClaimedProductionCheck,
} from "../production-checks-worker";

const BASE_CLAIM: ClaimedProductionCheck = {
  triggerId: "trig-1",
  sessionDocId: "session-1",
  checkDocId: "check-1",
  generation: 1,
  criteria: [
    {
      id: "crit-quick",
      predicate: { type: "turnCountUnder" as const, turns: 3 },
    },
    {
      id: "crit-tokens",
      predicate: { type: "tokenBudgetUnder" as const, tokens: 500 },
    },
  ],
  usage: { inputTokens: 120, outputTokens: 80 },
  envelope: {
    messages: [
      { role: "user", content: "help" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
  },
};

function mockServiceFetch() {
  const calls: Array<{ path: string; body: any }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      calls.push({
        path: new URL(url).pathname,
        body: JSON.parse(init.body),
      });
      return {
        status: 200,
        json: async () => ({ ok: true, applied: true }),
      } as Response;
    }),
  );
  return calls;
}

describe("executeClaimedCheck", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("grades the claim and reports id-keyed verdicts to /complete", async () => {
    const calls = mockServiceFetch();
    await executeClaimedCheck(BASE_CLAIM);

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/internal/v1/production-checks/complete");
    const body = calls[0].body;
    expect(body.checkDocId).toBe("check-1");
    expect(body.generation).toBe(1);
    // 1 user turn < 3 passes; 200 tokens < 500 passes — usage was measured,
    // not failed closed, because the claim carried the session totals.
    expect(body.criterionResults).toEqual([
      expect.objectContaining({ criterionId: "crit-quick", passed: true }),
      expect.objectContaining({ criterionId: "crit-tokens", passed: true }),
    ]);
  });

  it("fails tokenBudgetUnder closed when the claim carries no usage", async () => {
    const calls = mockServiceFetch();
    await executeClaimedCheck({ ...BASE_CLAIM, usage: null });

    const body = calls[0].body;
    expect(body.criterionResults[1]).toMatchObject({
      criterionId: "crit-tokens",
      passed: false,
    });
    expect(body.criterionResults[1].reason).toContain("unavailable");
  });

  it("reports an unreadable envelope to /fail, never /complete", async () => {
    const calls = mockServiceFetch();
    await executeClaimedCheck({ ...BASE_CLAIM, envelope: null });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/internal/v1/production-checks/fail");
    expect(calls[0].body.error).toBe("transcript envelope unreadable");
  });

  it("grades an EMPTY transcript rather than skipping it", async () => {
    const calls = mockServiceFetch();
    await executeClaimedCheck({
      ...BASE_CLAIM,
      envelope: { messages: [] },
    });

    expect(calls[0].path).toBe("/internal/v1/production-checks/complete");
    // Zero user turns is a real reading — `< 3` passes.
    expect(calls[0].body.criterionResults[0]).toMatchObject({
      criterionId: "crit-quick",
      passed: true,
    });
  });
});

describe("startProductionChecksWorker loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function flushLoop(times = 6) {
    return (async () => {
      for (let i = 0; i < times; i++) {
        await vi.advanceTimersByTimeAsync(20_000);
      }
    })();
  }

  it("stays inert without the service-token env — the only gate there is", async () => {
    // No flag guards this worker, so a deployment that is not an
    // infrastructure peer must self-gate here or every local dev inspector
    // would start polling.
    vi.unstubAllEnvs();
    const claim = vi.fn();

    const handle = startProductionChecksWorker({ claim });
    await flushLoop();
    await handle.stop();

    expect(claim).not.toHaveBeenCalled();
  });

  it("claims, executes, and keeps polling", async () => {
    const claim = vi
      .fn()
      .mockResolvedValueOnce({ kind: "claimed", claim: BASE_CLAIM })
      .mockResolvedValue({ kind: "empty" });
    const execute = vi.fn().mockResolvedValue(undefined);

    const handle = startProductionChecksWorker({ claim, execute });
    await flushLoop();
    handle.stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(BASE_CLAIM);
    expect(claim.mock.calls.length).toBeGreaterThan(1);
  });

  it("re-polls immediately after a drained (stale) trigger", async () => {
    const claim = vi
      .fn()
      .mockResolvedValueOnce({ kind: "drained" })
      .mockResolvedValueOnce({ kind: "claimed", claim: BASE_CLAIM })
      .mockResolvedValue({ kind: "empty" });
    const execute = vi.fn().mockResolvedValue(undefined);

    const handle = startProductionChecksWorker({ claim, execute });
    await flushLoop();
    handle.stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("survives claim errors with a backoff instead of crashing the loop", async () => {
    const claim = vi
      .fn()
      .mockRejectedValueOnce(new Error("backend down"))
      .mockResolvedValue({ kind: "empty" });
    const execute = vi.fn();

    const handle = startProductionChecksWorker({ claim, execute });
    await flushLoop(10);
    handle.stop();
    await vi.advanceTimersByTimeAsync(70_000);

    expect(claim.mock.calls.length).toBeGreaterThan(1);
    expect(execute).not.toHaveBeenCalled();
  });
});
