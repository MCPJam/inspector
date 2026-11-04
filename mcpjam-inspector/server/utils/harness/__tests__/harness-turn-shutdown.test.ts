import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createHarnessTurnShutdownHandle,
  resetHarnessTurnShutdownForTests,
  shutdownInFlightHarnessTurns,
} from "../harness-turn-shutdown";

/** A turn whose work runs until its shutdown signal aborts, then tears down. */
function runningTurn(teardownMs: number) {
  const turn = createHarnessTurnShutdownHandle();
  const finished = turn.track(
    () =>
      new Promise<void>((resolve) => {
        turn.signal.addEventListener("abort", () => {
          setTimeout(resolve, teardownMs);
        });
      }),
  );
  return { turn, finished };
}

describe("harness turn shutdown", () => {
  afterEach(() => {
    resetHarnessTurnShutdownForTests();
    vi.useRealTimers();
  });

  it("returns at once when no turn is running", async () => {
    const neverRun = createHarnessTurnShutdownHandle();
    const finished = createHarnessTurnShutdownHandle();
    await finished.track(async () => {});

    await expect(shutdownInFlightHarnessTurns(50)).resolves.toEqual({
      turns: 0,
      settled: true,
    });
    expect(neverRun.signal.aborted).toBe(false);
    expect(finished.signal.aborted).toBe(false);
  });

  it("aborts a running turn and waits for its teardown", async () => {
    const { turn, finished } = runningTurn(10);

    await expect(shutdownInFlightHarnessTurns(1_000)).resolves.toEqual({
      turns: 1,
      settled: true,
    });
    await finished;
    expect((turn.signal.reason as DOMException).name).toBe("AbortError");
  });

  it("stops waiting at the deadline for a teardown that hangs", async () => {
    vi.useFakeTimers();
    runningTurn(60_000);

    const stopped = shutdownInFlightHarnessTurns(4_000);
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(stopped).resolves.toEqual({ turns: 1, settled: false });
  });

  it("aborts a turn that starts after shutdown began", async () => {
    await shutdownInFlightHarnessTurns(50);
    const late = createHarnessTurnShutdownHandle();
    expect(late.signal.aborted).toBe(false);

    await late.track(async () => {
      expect(late.signal.aborted).toBe(true);
    });
  });

  it("stops tracking a turn whose work throws", async () => {
    const turn = createHarnessTurnShutdownHandle();
    await expect(
      turn.track(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(shutdownInFlightHarnessTurns(50)).resolves.toEqual({
      turns: 0,
      settled: true,
    });
  });
});
