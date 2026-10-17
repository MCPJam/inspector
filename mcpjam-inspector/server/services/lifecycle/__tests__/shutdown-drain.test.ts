import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => vi.fn());
const warnings = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/request-logger.js", () => ({
  getSystemLogger: () => ({ event: events }),
}));
vi.mock("../../../utils/logger.js", () => ({ logger: { warn: warnings } }));

import { createDrainCoordinator } from "../drain.js";
import { drainBeforeTeardown } from "../shutdown-drain.js";

function workersStoppingWith(stopped: Promise<void>) {
  return { stop: vi.fn(() => stopped) };
}

beforeEach(() => {
  events.mockReset();
  warnings.mockReset();
});

describe("drainBeforeTeardown", () => {
  it("closes admission, stops claiming, waits for the running job and records the drain", async () => {
    const drain = createDrainCoordinator();
    let finishJob!: () => void;
    // The job a claim loop registered when it started running it.
    drain.track(
      "claimed_job",
      new Promise<void>((resolve) => {
        finishJob = resolve;
      }),
    );
    const workers = workersStoppingWith(Promise.resolve());

    const done = drainBeforeTeardown(
      workers,
      { drainMs: 60_000, drainClamped: false },
      drain,
    );
    expect(drain.isDraining()).toBe(true);
    expect(workers.stop).toHaveBeenCalledTimes(1);
    finishJob();
    await done;

    expect(events).toHaveBeenCalledWith(
      "server.shutdown.drain",
      expect.objectContaining({
        drainMs: 60_000,
        drained: true,
        inFlightAtStart: 1,
        remainingClaimedJobs: 0,
      }),
    );
  });

  it("counts nothing in flight when no job is running", async () => {
    await drainBeforeTeardown(
      workersStoppingWith(Promise.resolve()),
      { drainMs: 60_000, drainClamped: false },
      createDrainCoordinator(),
    );

    expect(events).toHaveBeenCalledWith(
      "server.shutdown.drain",
      expect.objectContaining({ drained: true, inFlightAtStart: 0 }),
    );
  });

  it("waits for the job a claim answered after the stop registers", async () => {
    const drain = createDrainCoordinator();
    let finishJob!: () => void;
    // The loop's last claim comes back after the stop and starts its job; the
    // loop stops once that job is done.
    const workers = workersStoppingWith(
      Promise.resolve().then(() =>
        drain.track(
          "claimed_job",
          new Promise<void>((resolve) => {
            finishJob = resolve;
          }),
        ),
      ),
    );

    const done = drainBeforeTeardown(
      workers,
      { drainMs: 60_000, drainClamped: false },
      drain,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).not.toHaveBeenCalled();
    finishJob();
    await done;

    expect(events).toHaveBeenCalledWith(
      "server.shutdown.drain",
      expect.objectContaining({
        drained: true,
        inFlightAtStart: 0,
        remainingClaimedJobs: 0,
      }),
    );
  });

  it("gives up on a stuck job at the deadline so the teardown still runs", async () => {
    vi.useFakeTimers();
    try {
      const drain = createDrainCoordinator();
      drain.track("claimed_job", new Promise<void>(() => {}));
      const workers = workersStoppingWith(new Promise<void>(() => {}));

      const done = drainBeforeTeardown(
        workers,
        { drainMs: 1_000, drainClamped: true },
        drain,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await done;

      expect(events).toHaveBeenCalledWith(
        "server.shutdown.drain",
        expect.objectContaining({
          drained: false,
          drainClamped: true,
          remainingClaimedJobs: 1,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("without a drain, still waits for the claim loops as shutdown always has", async () => {
    const drain = createDrainCoordinator();
    let release!: () => void;
    const workers = workersStoppingWith(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    let finished = false;
    const done = drainBeforeTeardown(
      workers,
      { drainMs: 0, drainClamped: false },
      drain,
    ).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await done;
    expect(finished).toBe(true);
  });

  it("with a drain, reports a claim loop that fails to stop without failing the teardown", async () => {
    await expect(
      drainBeforeTeardown(
        workersStoppingWith(Promise.reject(new Error("stop failed"))),
        { drainMs: 1_000, drainClamped: false },
        createDrainCoordinator(),
      ),
    ).resolves.toBeUndefined();
    await Promise.resolve();

    expect(warnings).toHaveBeenCalledWith(
      "[shutdown] a claim loop failed to stop",
      { error: "stop failed" },
    );
  });

  it("without a drain, fails the shutdown when a claim loop fails to stop, as before", async () => {
    const drain = createDrainCoordinator();
    const workers = workersStoppingWith(
      Promise.reject(new Error("stop failed")),
    );

    await expect(
      drainBeforeTeardown(workers, { drainMs: 0, drainClamped: false }, drain),
    ).rejects.toThrow("stop failed");
  });
});
