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

  /** Each open emits one run-level event, then the server closes the stream. */
  function answerEveryOpenWith(type: "run_remote" | "run_complete") {
    streams.mockImplementation(async (_id, onEvent) => {
      onEvent({ ...runLevel, type } as SwarmStreamEvent);
    });
  }

  beforeEach(() => {
    streams.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reopens the stream after run_remote, and stops after the bounded retries", async () => {
    answerEveryOpenWith("run_remote");
    const { result } = renderHook(() => useJourneyRunStream("run-1", true));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // The first open plus six bounded reconnects, then the durable view alone.
    expect(streams).toHaveBeenCalledTimes(7);
    expect(result.current.runComplete).toBe(false);
    expect(result.current.connected).toBe(false);
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
