/**
 * Shared eval execution capacity, Inspector side.
 *
 * A hosted run's cases ask the backend (`convex/evalTrialSlots.ts`) for a slot
 * before they execute, so every Inspector replica draws from the same org
 * limits instead of counting runs in its own memory. One dispatcher per run:
 * it queues the run's cases once, asks for slots while any case waits,
 * heartbeats the slots it holds, and gives each back when its case ends.
 *
 * A case holds ONE slot across its repetitions: they run one after another,
 * so a case is one stream of work no matter how many repetitions it has.
 *
 * It never blocks a run on its own failure. A backend without the slot
 * functions (an older deployment) runs every case as before, and a slot
 * heartbeat that fails only logs: the backend keeps a lapsed slot until the
 * run ends, so a hiccup cannot double-book capacity.
 */
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { HOSTED_MODE } from "../../config.js";
import { logger } from "../../utils/logger";

export type TrialSlotClient = {
  mutation(
    ref: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ): Promise<unknown>;
};

/** The fields this dispatcher reads from any slot call's answer. */
type SlotReply = {
  status?: string;
  token?: string;
  heartbeatMs?: number;
  deadline?: number;
  granted?: { trialKey: string }[];
  expired?: string[];
  lost?: string[];
  more?: boolean;
} | null;

/**
 * - `granted`: the case may run now.
 * - `unthrottled`: the backend has no slot functions; run as before.
 * - `queue_expired`: no capacity came within the queue deadline.
 * - `stopped`: the run ended or was aborted while the case waited.
 */
export type TrialSlotOutcome =
  "granted" | "unthrottled" | "queue_expired" | "stopped";

const MISSING_FUNCTION = /Could not find public function for '/;
const ENQUEUE_BATCH = 500;
const HEARTBEAT_BATCH = 64;
const CLAIM_BATCH = 16;
/**
 * Cases one run may execute at once when shared slots are unavailable (an
 * older backend, or a queue the backend refused): the backend's per-group
 * cap, so a run is never unbounded just because the queue is down.
 */
const FALLBACK_CONCURRENCY = 4;
const DEFAULT_POLL_MS = 2_000;
const MAX_BACKOFF_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_QUEUE_DEADLINE_MS = 30 * 60_000;
/** The backend decides expiry; this side gives up on its own only past this
 * margin, for a backend it cannot reach, so clock skew never expires early. */
const LOCAL_DEADLINE_MARGIN_MS = 60_000;
const ENQUEUE_ATTEMPTS = 3;

/** Hosted runs share capacity; `MCPJAM_EVAL_SHARED_CAPACITY=0` turns it off. */
export function sharedEvalCapacityEnabled(): boolean {
  return HOSTED_MODE && process.env.MCPJAM_EVAL_SHARED_CAPACITY !== "0";
}

export function trialKeyForCase(index: number): string {
  return `case:${index}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, wake: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
    wake,
  ]).finally(() => clearTimeout(timer));
}

export type TrialSlotDispatcher = ReturnType<typeof createTrialSlotDispatcher>;

export function createTrialSlotDispatcher(opts: {
  client: TrialSlotClient;
  runId: string;
  signal: AbortSignal;
  /** The most one case may run once granted; the backend caps it again. */
  executionMs: number;
  pollMs?: number;
  /** Called whenever the number of waiting cases changes. */
  onWaitingChange?: (waiting: number) => void;
}) {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const waiters = new Map<string, (outcome: TrialSlotOutcome) => void>();
  const held = new Set<string>();
  let queued: string[] = [];
  let token: string | undefined;
  let heartbeatMs = DEFAULT_HEARTBEAT_MS;
  let deadline = Date.now() + DEFAULT_QUEUE_DEADLINE_MS;
  let lastBeatAt = 0;
  let unthrottled = false;
  let closed = false;
  let loop: Promise<void> | undefined;
  let kick = () => {};
  let wake = new Promise<void>((resolve) => (kick = resolve));
  const nudge = () => {
    kick();
    wake = new Promise<void>((resolve) => (kick = resolve));
  };
  const log = (message: string, error?: unknown) =>
    logger.warn(`[evals] trial slots: ${message}`, {
      runId: opts.runId,
      ...(error !== undefined ? { error: errorMessage(error) } : {}),
    });

  const settle = (keys: Iterable<string>, outcome: TrialSlotOutcome) => {
    let changed = false;
    for (const key of keys) {
      const resolve = waiters.get(key);
      if (!resolve) continue;
      waiters.delete(key);
      if (outcome === "granted") held.add(key);
      resolve(outcome);
      changed = true;
    }
    if (changed) opts.onWaitingChange?.(waitingCount());
  };

  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<SlotReply> =>
    (await opts.client.mutation(
      makeFunctionReference<"mutation">(`evalTrialSlots:${name}`),
      { runId: opts.runId, ...args },
    )) as SlotReply;

  // The local fallback cap (FALLBACK_CONCURRENCY) while shared slots are down.
  const fallbackHeld = new Set<string>();
  const fallbackQueue: {
    key: string;
    resolve: (outcome: TrialSlotOutcome) => void;
  }[] = [];
  const waitingCount = () => waiters.size + fallbackQueue.length;
  const runLocally = (
    key: string,
    resolve: (outcome: TrialSlotOutcome) => void,
  ) => {
    if (fallbackHeld.size < FALLBACK_CONCURRENCY) {
      fallbackHeld.add(key);
      resolve("unthrottled");
    } else {
      fallbackQueue.push({ key, resolve });
    }
  };

  /** Stop throttling: an older backend, or a queue the backend refused. */
  const runUnthrottled = (reason: string, error?: unknown) => {
    if (!unthrottled) {
      log(`${reason}; cases run ${FALLBACK_CONCURRENCY} at a time locally`, error);
    }
    unthrottled = true;
    for (const [key, resolve] of [...waiters]) {
      waiters.delete(key);
      runLocally(key, resolve);
    }
    opts.onWaitingChange?.(waitingCount());
  };

  const enqueue = async (keys: string[]) => {
    for (let i = 0; i < keys.length; i += ENQUEUE_BATCH) {
      const batch = keys.slice(i, i + ENQUEUE_BATCH);
      for (let attempt = 1; ; attempt++) {
        try {
          const response = await call("enqueueTrials", { trialKeys: batch });
          if (typeof response?.heartbeatMs === "number") {
            heartbeatMs = response.heartbeatMs;
          }
          if (typeof response?.deadline === "number") {
            deadline = response.deadline;
          }
          break;
        } catch (error) {
          if (MISSING_FUNCTION.test(errorMessage(error))) {
            return runUnthrottled("backend has no slot functions");
          }
          if (attempt >= ENQUEUE_ATTEMPTS) {
            return runUnthrottled("could not queue cases", error);
          }
          await sleep(pollMs * attempt, wake);
        }
      }
    }
  };

  const claim = async () => {
    const response = await call("claimTrialSlots", {
      max: Math.min(waiters.size, CLAIM_BATCH),
      executionMs: opts.executionMs,
      ...(token ? { token } : {}),
    });
    token = response?.token ?? token;
    if (typeof response?.heartbeatMs === "number") {
      heartbeatMs = response.heartbeatMs;
    }
    if (typeof response?.deadline === "number") deadline = response.deadline;
    switch (response?.status) {
      case "granted":
        settle(
          (response.granted ?? []).map((g: { trialKey: string }) => g.trialKey),
          "granted",
        );
        return true;
      case "queue_expired":
        settle(response.expired ?? [], "queue_expired");
        return true;
      case "run_ended":
        settle([...waiters.keys()], "stopped");
        return true;
      case "none_queued":
        // The backend no longer has these cases queued (swept as silent, or
        // never queued): queue them again rather than wait forever.
        // Then wait a poll, so a backend that keeps answering this can never
        // spin the loop.
        await enqueue([...waiters.keys()]);
        return false;
      default:
        return false;
    }
  };

  const heartbeat = async () => {
    const keys = [...held];
    for (let i = 0; i < keys.length; i += HEARTBEAT_BATCH) {
      const response = await call("heartbeatTrialSlots", {
        token,
        trialKeys: keys.slice(i, i + HEARTBEAT_BATCH),
      });
      if (response?.lost?.length) {
        log(`lost ${response.lost.length} slot(s); cases keep running`);
      }
    }
  };

  const pump = async () => {
    let backoffMs = pollMs;
    while (!closed && !unthrottled) {
      try {
        if (held.size > 0 && token && Date.now() - lastBeatAt >= heartbeatMs) {
          lastBeatAt = Date.now();
          await heartbeat();
        }
        if (waiters.size > 0) {
          if (Date.now() > deadline + LOCAL_DEADLINE_MARGIN_MS) {
            settle([...waiters.keys()], "queue_expired");
          } else if (await claim()) {
            backoffMs = pollMs;
            if (waiters.size > 0) continue;
          }
        }
        if (waiters.size === 0 && held.size === 0) return;
      } catch (error) {
        if (MISSING_FUNCTION.test(errorMessage(error))) {
          return runUnthrottled("backend has no slot functions");
        }
        log("slot call failed; retrying", error);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
      const jitter = Math.random() * pollMs * 0.25;
      const wait = waiters.size > 0 ? backoffMs + jitter : heartbeatMs;
      await sleep(Math.min(wait, heartbeatMs), wake);
    }
  };

  const ensureLoop = () => {
    if (closed || unthrottled) return;
    if (!loop) {
      loop = pump().finally(() => {
        loop = undefined;
        if (!closed && (waiters.size > 0 || held.size > 0)) ensureLoop();
      });
    } else {
      nudge();
    }
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    settle([...waiters.keys()], "stopped");
    for (const queued of fallbackQueue.splice(0)) queued.resolve("stopped");
    nudge();
    await loop?.catch((error) => log("slot loop failed while closing", error));
    if (unthrottled || queued.length === 0) return;
    // Free everything this run still queues or holds, in one call per batch.
    try {
      for (;;) {
        const response = await call("releaseTrialSlots", {
          ...(token ? { token } : {}),
        });
        if (!response?.more) break;
      }
    } catch (error) {
      log("could not release slots; the backend sweep will", error);
    }
  };
  opts.signal.addEventListener("abort", () => void close(), { once: true });

  return {
    /** Queue the run's cases. Call once, before the first `acquire`. */
    async start(keys: string[]): Promise<void> {
      queued = keys;
      if (keys.length > 0) await enqueue(keys);
    },
    /** Wait for this case's slot. Registers synchronously, then waits. */
    acquire(key: string): Promise<TrialSlotOutcome> {
      if (closed || opts.signal.aborted) return Promise.resolve("stopped");
      if (unthrottled) {
        const local = new Promise<TrialSlotOutcome>((resolve) =>
          runLocally(key, resolve),
        );
        opts.onWaitingChange?.(waitingCount());
        return local;
      }
      const outcome = new Promise<TrialSlotOutcome>((resolve) =>
        waiters.set(key, resolve),
      );
      opts.onWaitingChange?.(waiters.size);
      ensureLoop();
      return outcome;
    },
    /** Give a case's slot back once the case settles. Never throws. */
    async release(key: string): Promise<void> {
      if (fallbackHeld.delete(key)) {
        const next = fallbackQueue.shift();
        if (next) {
          fallbackHeld.add(next.key);
          next.resolve("unthrottled");
        }
        opts.onWaitingChange?.(waitingCount());
        return;
      }
      if (!held.delete(key) || unthrottled) return;
      try {
        await call("releaseTrialSlots", {
          ...(token ? { token } : {}),
          trialKeys: [key],
        });
      } catch (error) {
        log("could not release a slot; the backend sweep will", error);
      }
      ensureLoop();
    },
    waiting: waitingCount,
    close,
  };
}

/**
 * The whole-run clock, paused while any case waits for capacity: time spent
 * queued never counts against the run's execution budget.
 */
export function createPausableDeadline(ms: number, onExpire: () => void) {
  let remaining = ms;
  let startedAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const pause = () => {
    if (startedAt === undefined || done) return;
    clearTimeout(timer);
    remaining -= Date.now() - startedAt;
    startedAt = undefined;
  };
  const resume = () => {
    if (startedAt !== undefined || done) return;
    startedAt = Date.now();
    timer = setTimeout(
      () => {
        done = true;
        onExpire();
      },
      Math.max(0, remaining),
    );
  };
  return {
    pause,
    resume,
    clear: () => {
      done = true;
      clearTimeout(timer);
    },
  };
}
