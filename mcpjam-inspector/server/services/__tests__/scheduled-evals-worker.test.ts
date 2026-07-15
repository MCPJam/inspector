import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyFailure,
  startScheduledEvalsWorker,
} from "../scheduled-evals-worker";

const CLAIM = {
  triggerId: "trig-1",
  suiteId: "suite-1",
  suiteName: "Monitored Suite",
  organizationId: "org-1",
  projectId: "proj-1",
  createdByExternalId: "user_workos_1",
  scheduledFor: 1700000000000,
};

function flushLoop(times = 6) {
  // The loop interleaves awaits; advancing timers + draining microtasks a few
  // times settles one or more iterations deterministically under fake timers.
  return (async () => {
    for (let i = 0; i < times; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
    }
  })();
}

describe("startScheduledEvalsWorker loop", () => {
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

  it("claims and executes one trigger at a time, then keeps polling", async () => {
    const claim = vi
      .fn()
      .mockResolvedValueOnce(CLAIM)
      .mockResolvedValue(null);
    const execute = vi.fn().mockResolvedValue(undefined);

    const handle = startScheduledEvalsWorker({ claim, execute });
    await flushLoop();
    handle.stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(CLAIM);
    expect(claim.mock.calls.length).toBeGreaterThan(1);
  });

  it("survives claim errors with a backoff instead of crashing the loop", async () => {
    const claim = vi
      .fn()
      .mockRejectedValueOnce(new Error("backend down"))
      .mockResolvedValue(null);
    const execute = vi.fn();

    const handle = startScheduledEvalsWorker({ claim, execute });
    await flushLoop(8);
    handle.stop();
    await vi.advanceTimersByTimeAsync(70_000);

    expect(execute) .not.toHaveBeenCalled();
    expect(claim.mock.calls.length).toBeGreaterThan(1);
  });

  it("backs off without executing when the backend reports the feature disabled", async () => {
    const claim = vi.fn().mockResolvedValue("disabled" as const);
    const execute = vi.fn();

    const handle = startScheduledEvalsWorker({ claim, execute });
    await flushLoop(3);
    handle.stop();
    await vi.advanceTimersByTimeAsync(70_000);

    expect(execute).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalled();
  });

  it("stop() ends the loop", async () => {
    const claim = vi.fn().mockResolvedValue(null);
    const handle = startScheduledEvalsWorker({ claim, execute: vi.fn() });
    await flushLoop(2);
    handle.stop();
    const callsAtStop = claim.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(claim.mock.calls.length).toBe(callsAtStop);
  });

  it("does not start without the service credentials", async () => {
    vi.unstubAllEnvs();
    const claim = vi.fn();
    const handle = startScheduledEvalsWorker({ claim, execute: vi.fn() });
    await flushLoop(2);
    handle.stop();
    expect(claim).not.toHaveBeenCalled();
  });
});

describe("classifyFailure", () => {
  it("maps the canonical billing-limit code to quota_exhausted (pauses the schedule)", () => {
    expect(
      classifyFailure(new Error("billing_limit_reached: eval iterations")),
    ).toBe("quota_exhausted");
  });

  it("maps delegated-mint 401/403 failures to auth (pauses the schedule)", () => {
    expect(
      classifyFailure(new Error("Delegated token exchange failed (403)")),
    ).toBe("auth");
    expect(
      classifyFailure(new Error("Delegated token exchange failed (401)")),
    ).toBe("auth");
  });

  it("does NOT pause on loose substring matches (retryable failures stay retryable)", () => {
    // An MCP server error merely mentioning these words must not pause
    // the schedule.
    expect(
      classifyFailure(new Error("server replied: quota header missing")),
    ).toMatch(/^run_create_failed: /);
    expect(
      classifyFailure(new Error("upstream FORBIDDEN while fetching tools")),
    ).toMatch(/^run_create_failed: /);
    expect(
      classifyFailure(new Error("user is not a member of channel #general")),
    ).toMatch(/^run_create_failed: /);
  });

  it("falls back to a bounded run_create_failed reason", () => {
    const reason = classifyFailure(new Error("x".repeat(500)));
    expect(reason.startsWith("run_create_failed: ")).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(
      "run_create_failed: ".length + 160,
    );
  });
});
