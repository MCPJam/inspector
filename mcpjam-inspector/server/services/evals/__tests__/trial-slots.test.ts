import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPausableDeadline,
  createTrialSlotDispatcher,
  trialKeyForCase,
  type TrialSlotClient,
} from "../trial-slots.js";

/**
 * A tiny stand-in for `convex/evalTrialSlots.ts`: one org cap shared by every
 * caller, so two dispatchers are two Inspector replicas on one backend.
 */
function fakeBackend(cap: number) {
  const queued = new Map<string, string[]>();
  const active = new Set<string>();
  let peak = 0;
  const calls: { name: string; args: any }[] = [];
  const client = (): TrialSlotClient => ({
    async mutation(name: string, args: any) {
      calls.push({ name, args });
      const run = args.runId as string;
      const queue = queued.get(run) ?? [];
      queued.set(run, queue);
      switch (name) {
        case "evalTrialSlots:enqueueTrials":
          queue.push(...args.trialKeys);
          return { enqueued: args.trialKeys.length, heartbeatMs: 20 };
        case "evalTrialSlots:claimTrialSlots": {
          const granted: { trialKey: string }[] = [];
          while (
            queue.length &&
            active.size < cap &&
            granted.length < args.max
          ) {
            const trialKey = queue.shift()!;
            active.add(`${run}/${trialKey}`);
            granted.push({ trialKey });
          }
          peak = Math.max(peak, active.size);
          return granted.length
            ? { status: "granted", token: `tok-${run}`, granted }
            : { status: "waiting", token: `tok-${run}` };
        }
        case "evalTrialSlots:heartbeatTrialSlots":
          return { renewed: args.trialKeys.length, lost: [] };
        case "evalTrialSlots:releaseTrialSlots":
          for (const key of args.trialKeys ?? [...queue]) {
            active.delete(`${run}/${key}`);
          }
          if (!args.trialKeys) queue.length = 0;
          return { released: 1, more: false };
      }
      throw new Error(`unexpected ${name}`);
    },
  });
  return { client, calls, peak: () => peak, active };
}

const keys = (n: number) =>
  Array.from({ length: n }, (_, i) => trialKeyForCase(i));

async function runCases(
  dispatcher: ReturnType<typeof createTrialSlotDispatcher>,
  n: number,
  backend: ReturnType<typeof fakeBackend>,
) {
  await dispatcher.start(keys(n));
  await Promise.all(
    keys(n).map(async (key) => {
      expect(await dispatcher.acquire(key)).toBe("granted");
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(backend.active.size).toBeLessThanOrEqual(3);
      await dispatcher.release(key);
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("trial slot dispatcher", () => {
  it("keeps two replicas inside one shared cap and runs every case", async () => {
    const backend = fakeBackend(3);
    const make = (runId: string) =>
      createTrialSlotDispatcher({
        client: backend.client(),
        runId,
        signal: new AbortController().signal,
        executionMs: 60_000,
        pollMs: 2,
      });
    const a = make("run-a");
    const b = make("run-b");
    await Promise.all([runCases(a, 6, backend), runCases(b, 6, backend)]);
    expect(backend.peak()).toBe(3);
    expect(backend.active.size).toBe(0);
    await Promise.all([a.close(), b.close()]);
  });

  it("reports the waiting count so the run clock can pause", async () => {
    const backend = fakeBackend(1);
    const counts: number[] = [];
    const dispatcher = createTrialSlotDispatcher({
      client: backend.client(),
      runId: "run-a",
      signal: new AbortController().signal,
      executionMs: 60_000,
      pollMs: 2,
      onWaitingChange: (waiting) => counts.push(waiting),
    });
    await dispatcher.start(keys(2));
    const first = dispatcher.acquire(trialKeyForCase(0));
    const second = dispatcher.acquire(trialKeyForCase(1));
    expect(await first).toBe("granted");
    expect(dispatcher.waiting()).toBe(1);
    await dispatcher.release(trialKeyForCase(0));
    expect(await second).toBe("granted");
    expect(counts.at(-1)).toBe(0);
    expect(Math.max(...counts)).toBe(2);
    await dispatcher.close();
  });

  it("frees the queue when the run is cancelled while cases wait", async () => {
    const backend = fakeBackend(0);
    const controller = new AbortController();
    const dispatcher = createTrialSlotDispatcher({
      client: backend.client(),
      runId: "run-a",
      signal: controller.signal,
      executionMs: 60_000,
      pollMs: 2,
    });
    await dispatcher.start(keys(2));
    const waiting = dispatcher.acquire(trialKeyForCase(0));
    controller.abort();
    expect(await waiting).toBe("stopped");
    await vi.waitFor(() =>
      expect(
        backend.calls.some(
          (call) =>
            call.name === "evalTrialSlots:releaseTrialSlots" &&
            call.args.trialKeys === undefined,
        ),
      ).toBe(true),
    );
    expect(await dispatcher.acquire(trialKeyForCase(1))).toBe("stopped");
  });

  it("hands back queue expiry for the cases the backend expired", async () => {
    const client: TrialSlotClient = {
      mutation: vi.fn(async (name: string) =>
        name === "evalTrialSlots:claimTrialSlots"
          ? { status: "queue_expired", token: "t", expired: ["case:0"] }
          : { enqueued: 1 },
      ),
    };
    const dispatcher = createTrialSlotDispatcher({
      client,
      runId: "run-a",
      signal: new AbortController().signal,
      executionMs: 60_000,
      pollMs: 2,
    });
    await dispatcher.start(keys(1));
    expect(await dispatcher.acquire(trialKeyForCase(0))).toBe("queue_expired");
    await dispatcher.close();
  });

  it("runs every case as before against a backend without slot functions", async () => {
    const client: TrialSlotClient = {
      mutation: vi.fn(async (name: string) => {
        throw new Error(`Could not find public function for '${name}'`);
      }),
    };
    const dispatcher = createTrialSlotDispatcher({
      client,
      runId: "run-a",
      signal: new AbortController().signal,
      executionMs: 60_000,
      pollMs: 2,
    });
    await dispatcher.start(keys(2));
    expect(await dispatcher.acquire(trialKeyForCase(0))).toBe("unthrottled");
    expect(await dispatcher.acquire(trialKeyForCase(1))).toBe("unthrottled");
    await dispatcher.close();
    expect(client.mutation).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting through a transient backend error", async () => {
    const backend = fakeBackend(1);
    const real = backend.client();
    let failures = 2;
    const client: TrialSlotClient = {
      mutation: async (name, args) => {
        if (name === "evalTrialSlots:claimTrialSlots" && failures-- > 0) {
          throw new Error("fetch failed");
        }
        return real.mutation(name, args);
      },
    };
    const dispatcher = createTrialSlotDispatcher({
      client,
      runId: "run-a",
      signal: new AbortController().signal,
      executionMs: 60_000,
      pollMs: 2,
    });
    await dispatcher.start(keys(1));
    expect(await dispatcher.acquire(trialKeyForCase(0))).toBe("granted");
    await dispatcher.close();
  });
});

describe("pausable run clock", () => {
  it("does not count time spent paused", () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const clock = createPausableDeadline(1_000, expired);
    // Queued from the start: the clock has not begun.
    vi.advanceTimersByTime(60_000);
    clock.resume();
    vi.advanceTimersByTime(400);
    clock.pause();
    vi.advanceTimersByTime(60_000);
    expect(expired).not.toHaveBeenCalled();
    clock.resume();
    vi.advanceTimersByTime(599);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("never fires once cleared", () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const clock = createPausableDeadline(1_000, expired);
    clock.resume();
    clock.clear();
    clock.resume();
    vi.advanceTimersByTime(5_000);
    expect(expired).not.toHaveBeenCalled();
  });
});
