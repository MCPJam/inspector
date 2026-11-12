import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONFORMANCE_HEARTBEAT_INTERVAL_MS,
  ConformanceRunCancelledError,
  startConformanceRunLifecycle,
} from "../conformance-run-lifecycle.js";

describe("startConformanceRunLifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts within one heartbeat once the backend says the run is settled", async () => {
    const heartbeat = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValue({ ok: false, error: "terminal" });
    const lifecycle = startConformanceRunLifecycle({
      heartbeat,
      onHeartbeatError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(CONFORMANCE_HEARTBEAT_INTERVAL_MS);
    expect(lifecycle.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(CONFORMANCE_HEARTBEAT_INTERVAL_MS);
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.cancelled()).toBe(true);
    expect(lifecycle.signal.reason).toBeInstanceOf(
      ConformanceRunCancelledError,
    );

    // Settled is final: no more heartbeats are sent.
    await vi.advanceTimersByTimeAsync(CONFORMANCE_HEARTBEAT_INTERVAL_MS * 3);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    lifecycle.stop();
  });

  it("aborts at the run's budget with the same message the app shows", async () => {
    const lifecycle = startConformanceRunLifecycle({
      runTimeoutSeconds: 30,
      heartbeat: vi.fn().mockResolvedValue({ ok: true }),
      onHeartbeatError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(29_000);
    expect(lifecycle.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.cancelled()).toBe(false);
    expect((lifecycle.signal.reason as Error).message).toBe(
      "Run timed out after 30 seconds",
    );
    lifecycle.stop();
  });

  it("has no deadline without a budget, and keeps beating through a failed heartbeat", async () => {
    const onHeartbeatError = vi.fn();
    const heartbeat = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ ok: true });
    const lifecycle = startConformanceRunLifecycle({
      heartbeat,
      onHeartbeatError,
    });

    await vi.advanceTimersByTimeAsync(CONFORMANCE_HEARTBEAT_INTERVAL_MS * 20);
    expect(onHeartbeatError).toHaveBeenCalledTimes(1);
    expect(heartbeat).toHaveBeenCalledTimes(20);
    expect(lifecycle.signal.aborted).toBe(false);
    lifecycle.stop();
  });

  it("records a cancel learned from a refused write", () => {
    const lifecycle = startConformanceRunLifecycle({
      heartbeat: vi.fn().mockResolvedValue({ ok: true }),
      onHeartbeatError: vi.fn(),
    });
    lifecycle.markCancelled();
    expect(lifecycle.cancelled()).toBe(true);
    expect(lifecycle.signal.aborted).toBe(true);
    lifecycle.stop();
  });
});
