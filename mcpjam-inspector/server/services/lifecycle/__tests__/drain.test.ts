import { describe, expect, it, vi } from "vitest";
import { createDrainCoordinator } from "../drain.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("drain coordinator", () => {
  it("admits until a drain begins", () => {
    const drain = createDrainCoordinator();
    expect(drain.isDraining()).toBe(false);
    drain.begin();
    expect(drain.isDraining()).toBe(true);
  });

  it("waits for accepted work, including work that fails", async () => {
    const drain = createDrainCoordinator();
    const run = deferred();
    const pass = deferred();
    drain.track("eval_run", run.promise);
    // `track` observes the rejection itself, so a failed pass is still the end
    // of that work for the drain (its owner reports the failure).
    drain.track("doorbell", pass.promise);

    const drained = drain.drain(60_000);
    run.resolve();
    pass.reject(new Error("pass failed"));

    await expect(drained).resolves.toMatchObject({
      drained: true,
      inFlightAtStart: { eval_run: 1, doorbell: 1 },
      remaining: {},
    });
    expect(drain.isDraining()).toBe(true);
  });

  it("waits for work registered while it drains", async () => {
    const drain = createDrainCoordinator();
    const job = deferred();
    const followUp = deferred();
    drain.track("claimed_job", job.promise);

    const drained = drain.drain(60_000);
    // A claimed job starting its last step after the drain began.
    drain.track("eval_run", followUp.promise);
    job.resolve();
    let finished = false;
    void drained.then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    expect(drain.counts()).toEqual({ eval_run: 1 });
    followUp.resolve();

    await expect(drained).resolves.toMatchObject({ drained: true });
  });

  it("stops waiting at its deadline and reports what is still running", async () => {
    vi.useFakeTimers();
    try {
      const drain = createDrainCoordinator();
      drain.track("swarm_run", new Promise<void>(() => {}));
      drain.track("eval_run", Promise.resolve());

      const drained = drain.drain(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(drained).resolves.toMatchObject({
        drained: false,
        remaining: { swarm_run: 1 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns at once with no deadline, as a shutdown without a drain does", async () => {
    // A stopped clock, so `waitedMs` shows the drain never waited rather than
    // whether the real clock ticked between its two readings.
    const drain = createDrainCoordinator(() => 0);
    drain.track("claimed_job", new Promise<void>(() => {}));

    await expect(drain.drain(0)).resolves.toMatchObject({
      drained: false,
      waitedMs: 0,
      remaining: { claimed_job: 1 },
    });
  });
});
