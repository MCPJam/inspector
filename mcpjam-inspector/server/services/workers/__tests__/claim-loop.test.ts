import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startClaimLoop, type ClaimResult } from "../claim-loop";

type Job = { id: string };
const JOB: Job = { id: "job-1" };

function makeLog() {
  return { started: vi.fn(), pollFailed: vi.fn(), stopped: vi.fn() };
}

function makeClaim() {
  return vi.fn(
    async (_claimedBy: string): Promise<ClaimResult<Job>> => null,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets pending callbacks run without moving the clock. */
async function settle() {
  for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(0);
}

function trackStop(loop: { stop(): Promise<void> }) {
  const state = { done: false };
  void loop.stop().then(() => {
    state.done = true;
  });
  return state;
}

describe("startClaimLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubEnv("RAILWAY_REPLICA_ID", "replica-1");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each<[string, ClaimResult<Job>, number]>([
    ["1 s after a job", JOB, 1_000],
    ["15 s after an empty claim", null, 15_000],
    ["250 ms after a drained claim", "drained", 250],
    ["60 s while the feature is off", "disabled", 60_000],
  ])("claims again %s", async (_label, first, delayMs) => {
    const claim = makeClaim().mockResolvedValueOnce(first);
    const execute = vi.fn(async () => {});
    const loop = startClaimLoop({
      claimedByPrefix: "test-",
      claim,
      execute,
      log: makeLog(),
    });

    await settle();
    expect(claim).toHaveBeenCalledTimes(1);
    // Only a job runs; an empty, drained or disabled claim never does.
    expect(execute).toHaveBeenCalledTimes(first === JOB ? 1 : 0);
    await vi.advanceTimersByTimeAsync(delayMs - 1);
    expect(claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(claim).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("adds up to 5 s of jitter to an idle poll", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    const claim = makeClaim();
    const loop = startClaimLoop({
      claimedByPrefix: "test-",
      claim,
      execute: vi.fn(async () => {}),
      log: makeLog(),
    });

    await settle();
    await vi.advanceTimersByTimeAsync(19_998);
    expect(claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(claim).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("names the worker after its prefix and replica, in the claim and the job", async () => {
    const claim = makeClaim().mockResolvedValueOnce(JOB);
    const execute = vi.fn(async () => {});
    const log = makeLog();
    const loop = startClaimLoop({ claimedByPrefix: "test-", claim, execute, log });

    await settle();
    expect(log.started).toHaveBeenCalledWith("test-replica-1");
    expect(claim).toHaveBeenCalledWith("test-replica-1");
    expect(execute).toHaveBeenCalledWith(JOB, "test-replica-1");

    await loop.stop();
  });

  it("falls back to the pid off Railway", async () => {
    delete process.env.RAILWAY_REPLICA_ID;
    const claim = makeClaim();
    const loop = startClaimLoop({
      claimedByPrefix: "test-",
      claim,
      execute: vi.fn(async () => {}),
      log: makeLog(),
    });

    await settle();
    expect(claim).toHaveBeenCalledWith(`test-${process.pid}`);

    await loop.stop();
  });

  it("logs a failed claim and waits 60 s before the next one", async () => {
    const claim = makeClaim().mockRejectedValueOnce(new Error("backend down"));
    const log = makeLog();
    const loop = startClaimLoop({
      claimedByPrefix: "test-",
      claim,
      execute: vi.fn(async () => {}),
      log,
    });

    await settle();
    expect(log.pollFailed).toHaveBeenCalledWith("backend down");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(claim).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("logs a failed job and waits 60 s before the next claim", async () => {
    const claim = makeClaim().mockResolvedValueOnce(JOB);
    const log = makeLog();
    const loop = startClaimLoop({
      claimedByPrefix: "test-",
      claim,
      execute: vi.fn(async () => {
        throw new Error("job broke");
      }),
      log,
    });

    await settle();
    expect(log.pollFailed).toHaveBeenCalledWith("job broke");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(claim).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("does not claim again while a job is running", async () => {
    const job = deferred<void>();
    const claim = makeClaim().mockResolvedValueOnce(JOB);
    const loop = startClaimLoop({
      claimedByPrefix: "test-",
      claim,
      execute: vi.fn(() => job.promise),
      log: makeLog(),
    });

    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(claim).toHaveBeenCalledTimes(1);

    job.resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claim).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("stops at once while waiting between claims", async () => {
    const claim = makeClaim();
    const log = makeLog();
    const loop = startClaimLoop({
      claimedByPrefix: "test-",
      claim,
      execute: vi.fn(async () => {}),
      log,
    });

    await settle();
    const stopped = trackStop(loop);
    await settle();

    expect(stopped.done).toBe(true);
    expect(log.stopped).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("stops as soon as a pending claim settles, without waiting out the next delay", async () => {
    const pending = deferred<ClaimResult<Job>>();
    const claim = makeClaim().mockReturnValueOnce(pending.promise);
    const loop = startClaimLoop({
      claimedByPrefix: "test-",
      claim,
      execute: vi.fn(async () => {}),
      log: makeLog(),
    });

    await settle();
    const stopped = trackStop(loop);
    pending.resolve(null);
    await settle();

    expect(stopped.done).toBe(true);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("waits for a running job before stopping", async () => {
    const job = deferred<void>();
    const claim = makeClaim().mockResolvedValueOnce(JOB);
    const loop = startClaimLoop({
      claimedByPrefix: "test-",
      claim,
      execute: vi.fn(() => job.promise),
      log: makeLog(),
    });

    await settle();
    const stopped = trackStop(loop);
    await settle();
    expect(stopped.done).toBe(false);

    job.resolve();
    await settle();
    expect(stopped.done).toBe(true);
  });

  it("can be stopped twice and logs start and stop once each", async () => {
    const log = makeLog();
    const loop = startClaimLoop({
      claimedByPrefix: "test-",
      claim: makeClaim(),
      execute: vi.fn(async () => {}),
      log,
    });

    await settle();
    await loop.stop();
    await loop.stop();

    expect(log.started).toHaveBeenCalledTimes(1);
    expect(log.stopped).toHaveBeenCalledTimes(1);
  });
});
