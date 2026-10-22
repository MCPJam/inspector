import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwarmStreamEvent } from "@/shared/swarm-stream-events";
import { useJourneyRunStream } from "../use-journey-run-stream";

const streams = vi.hoisted(() => vi.fn());
vi.mock("@/lib/swarm-api", () => ({ streamJourneyRun: streams }));

describe("selected run stream lifecycle", () => {
  beforeEach(() => {
    streams.mockReset();
  });

  it("aborts a deselected stream and ignores events delivered after cleanup", async () => {
    let emit!: (event: SwarmStreamEvent) => void;
    let finish!: () => void;
    let signal!: AbortSignal;
    streams.mockImplementation((_id, onEvent, abortSignal) => {
      emit = onEvent;
      signal = abortSignal;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const { result, rerender } = renderHook(
      ({ enabled }) => useJourneyRunStream("run-1", enabled),
      { initialProps: { enabled: true } },
    );
    expect(streams).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      emit({
        type: "attempt_status",
        status: "running",
        runId: "run-1",
        hostId: "host",
        sessionIndex: 0,
        chatSessionId: "session",
      });
      finish();
    });
    expect(result.current.sessions).toEqual({});
    expect(result.current.connected).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe("stream answered by a server without the run's runner", () => {
  const runLevel = {
    runId: "run-1",
    hostId: "",
    chatSessionId: "",
    sessionIndex: -1,
  };

  /**
   * Each open emits one run-level event, then the server closes the stream.
   * Returns when each open happened, in fake-clock milliseconds.
   */
  function answerEveryOpenWith(type: "run_remote" | "run_complete") {
    const start = Date.now();
    const openedAt: number[] = [];
    streams.mockImplementation(async (_id, onEvent) => {
      openedAt.push(Date.now() - start);
      onEvent({ ...runLevel, type } as SwarmStreamEvent);
    });
    return openedAt;
  }

  beforeEach(() => {
    streams.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reopens the stream after run_remote, and stops after the bounded retries", async () => {
    const openedAt = answerEveryOpenWith("run_remote");
    const { result } = renderHook(() => useJourneyRunStream("run-1", true));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // The first open plus six reconnects 1, 2, 4, 8, 15 and 15 s apart, then
    // the durable view alone.
    expect(openedAt).toEqual([0, 1_000, 3_000, 7_000, 15_000, 30_000, 45_000]);
    expect(result.current.runComplete).toBe(false);
    expect(result.current.connected).toBe(false);
  });

  it("spends a retry on a reopen that fails instead of ending the chain", async () => {
    streams.mockImplementationOnce(async (_id, onEvent) => {
      onEvent({ ...runLevel, type: "run_remote" } as SwarmStreamEvent);
    });
    // Every reopen fails, as one landing on a replica mid-deploy would.
    streams.mockRejectedValue(new Error("Run not found"));
    const { result } = renderHook(() => useJourneyRunStream("run-1", true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(streams).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    // Every retry was spent; only the failure with none left is shown.
    expect(streams).toHaveBeenCalledTimes(7);
    expect(result.current.error).toBe("Run not found");
  });

  it("is live only once a stream delivers the runner's events", async () => {
    let emit!: (event: SwarmStreamEvent) => void;
    streams.mockImplementationOnce(async (_id, onEvent) => {
      onEvent({ ...runLevel, type: "run_remote" } as SwarmStreamEvent);
    });
    streams.mockImplementationOnce((_id, onEvent) => {
      emit = onEvent;
      return new Promise<void>(() => {});
    });
    const { result } = renderHook(() => useJourneyRunStream("run-1", true));
    expect(result.current.connected).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    // The reopen is open, but nothing has arrived on it yet.
    expect(streams).toHaveBeenCalledTimes(2);
    expect(result.current.connected).toBe(false);

    await act(async () => {
      emit({
        type: "session_start",
        runId: "run-1",
        hostId: "host",
        chatSessionId: "session",
        sessionIndex: 0,
      });
    });
    expect(result.current.connected).toBe(true);
  });

  it("does not reopen a stream that ended in run_complete", async () => {
    answerEveryOpenWith("run_complete");
    const { result } = renderHook(() => useJourneyRunStream("run-1", true));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(streams).toHaveBeenCalledTimes(1);
    expect(result.current.runComplete).toBe(true);
  });

  it("is never live on a stream that only answers run_complete", async () => {
    streams.mockImplementation((_id, onEvent) => {
      onEvent({ ...runLevel, type: "run_complete" } as SwarmStreamEvent);
      return new Promise<void>(() => {});
    });
    const { result } = renderHook(() => useJourneyRunStream("run-1", true));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.runComplete).toBe(true);
    expect(result.current.connected).toBe(false);
  });

  it("cancels a pending reconnect when the stream is disabled", async () => {
    answerEveryOpenWith("run_remote");
    const { rerender } = renderHook(
      ({ enabled }) => useJourneyRunStream("run-1", enabled),
      { initialProps: { enabled: true } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(streams).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(streams).toHaveBeenCalledTimes(1);
  });
});
