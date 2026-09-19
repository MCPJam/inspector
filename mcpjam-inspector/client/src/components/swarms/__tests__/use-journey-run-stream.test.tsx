import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
