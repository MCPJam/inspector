import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "hono";
import { logger } from "./logger.js";

export class LocalCheckError extends Error {
  constructor(
    readonly status: 409 | 429 | 503,
    readonly reason: string,
  ) {
    super(
      reason === "SERVER_CHECK_PREEMPTED"
        ? "Automatic check queued for a manual connection."
        : "Server checks are busy. Please retry shortly.",
    );
  }
}
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const preempted = () => new LocalCheckError(409, "SERVER_CHECK_PREEMPTED");
export const localCheckScope = new AsyncLocalStorage<AbortSignal>();
export function withLocalCheckSignal(
  signal?: AbortSignal | null,
): AbortSignal | undefined {
  const attempt = localCheckScope.getStore();
  return attempt
    ? signal
      ? AbortSignal.any([attempt, signal])
      : attempt
    : (signal ?? undefined);
}
type Job = {
  id: string;
  owner: string;
  key: string;
  target?: string;
  automatic: boolean;
  order: number;
  queuedAt: number;
  controller: AbortController;
  started?: number;
  timer?: ReturnType<typeof setTimeout>;
  run: (signal: AbortSignal) => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  detach: () => void;
};

// One coordinator per local server process, shared by all of its browser tabs.
export class LocalServerCheckQueue {
  private jobs = new Map<string, Job>();
  private sequence = 0;
  private stopped = false;
  private identity(owner: string, id: string) {
    return JSON.stringify([owner, id]);
  }
  run<T>(
    args: {
      owner: string;
      requestId: string;
      key: string;
      target?: string;
      intent: "manual" | "automatic";
      signal: AbortSignal;
    },
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.stopped)
      return Promise.reject(
        new LocalCheckError(503, "SERVER_CHECK_QUEUE_UNAVAILABLE"),
      );
    if (args.signal.aborted) return Promise.reject(args.signal.reason);
    const identity = this.identity(args.owner, args.requestId);
    const existing = this.jobs.get(identity);
    if (existing)
      return existing.key === args.key && existing.target === args.target
        ? (existing.promise as Promise<T>)
        : Promise.reject(
            new LocalCheckError(409, "SERVER_CHECK_REQUEST_CONFLICT"),
          );
    const waiting = [...this.jobs.values()].filter(
      (j) => j.started === undefined,
    );
    if (waiting.length >= 100) {
      const victim =
        args.intent === "manual"
          ? waiting.filter((j) => j.automatic).at(-1)
          : undefined;
      if (!victim) {
        logger.info("[local-server-check.queue] rejected", {
          reason: "SERVER_CHECK_QUEUE_FULL",
          waiting: waiting.length,
        });
        return Promise.reject(
          new LocalCheckError(429, "SERVER_CHECK_QUEUE_FULL"),
        );
      }
      this.cancel(victim, preempted());
    }
    let resolve!: Job["resolve"], reject!: Job["reject"];
    const promise = new Promise<unknown>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const job: Job = {
      id: args.requestId,
      owner: args.owner,
      key: args.key,
      target: args.target,
      automatic: args.intent === "automatic",
      order: ++this.sequence,
      queuedAt: Date.now(),
      controller: new AbortController(),
      run,
      promise,
      resolve,
      reject,
      detach: () => {},
    };
    const abort = () => this.cancel(job, args.signal.reason);
    args.signal.addEventListener("abort", abort, { once: true });
    job.detach = () => args.signal.removeEventListener("abort", abort);
    job.timer = setTimeout(
      () =>
        this.cancel(
          job,
          new LocalCheckError(429, "SERVER_CHECK_QUEUE_TIMEOUT"),
        ),
      30_000,
    );
    this.jobs.set(identity, job);
    this.drain();
    return promise as Promise<T>;
  }
  promote(owner: string, id: string) {
    const job = this.jobs.get(this.identity(owner, id));
    if (!job) return { state: "expired" };
    if (job.controller.signal.aborted) return { state: "preempted" };
    if (job.automatic) {
      job.automatic = false;
      job.order = ++this.sequence;
    }
    this.drain();
    return { state: job.started === undefined ? "waiting" : "active" };
  }
  private cancel(job: Job, reason: unknown) {
    if (job.controller.signal.aborted) return;
    job.controller.abort(reason);
    if (reason instanceof LocalCheckError && reason.status === 429) {
      logger.info("[local-server-check.queue] rejected", {
        reason: reason.reason,
        waitMs: Date.now() - job.queuedAt,
      });
    }
    if (job.started === undefined) {
      this.remove(job);
      job.reject(reason);
      this.drain();
    }
  }
  private remove(job: Job) {
    clearTimeout(job.timer);
    job.detach();
    this.jobs.delete(this.identity(job.owner, job.id));
  }
  private drain() {
    if (this.stopped) return;
    const active = [...this.jobs.values()].filter(
      (j) => j.started !== undefined,
    );
    const keys = new Set(active.map((j) => j.key));
    const pending = [...this.jobs.values()]
      .filter((j) => j.started === undefined)
      .sort(
        (a, b) =>
          Number(a.automatic) - Number(b.automatic) || a.order - b.order,
      );
    for (const job of pending) {
      if (active.length >= 10) break;
      if (keys.has(job.key)) continue;
      clearTimeout(job.timer);
      job.started = ++this.sequence;
      active.push(job);
      keys.add(job.key);
      logger.info("[local-server-check.queue] admitted", {
        active: active.length,
        automatic: job.automatic,
        waitMs: Date.now() - job.queuedAt,
      });
      // Queue waiting is outside the connection deadline.
      job.timer = setTimeout(
        () =>
          this.cancel(
            job,
            new DOMException("Connection attempt timed out", "TimeoutError"),
          ),
        20_000,
      );
      void Promise.resolve()
        .then(() => {
          job.controller.signal.throwIfAborted();
          return job.run(job.controller.signal);
        })
        .then((value) => {
          job.controller.signal.throwIfAborted();
          return value;
        })
        .then(
          (value) => {
            this.remove(job);
            job.resolve(value);
            this.drain();
          },
          (error) => {
            this.remove(job);
            job.reject(
              job.controller.signal.aborted
                ? job.controller.signal.reason
                : error,
            );
            this.drain();
          },
        );
    }
    // Slots being cleaned up already count toward manual demand. A same-key
    // waiter must wait for its own attempt, not interrupt unrelated work.
    const manualKeys = new Set(
      pending
        .filter((j) => j.started === undefined && !j.automatic)
        .map((j) => j.key),
    );
    for (const job of active) {
      if (
        manualKeys.has(job.key) &&
        job.automatic &&
        !job.controller.signal.aborted
      )
        this.interrupt(job);
    }
    let capacity =
      10 -
      active.length +
      active.filter(
        (j) => j.controller.signal.aborted && !manualKeys.has(j.key),
      ).length;
    for (const key of manualKeys) {
      if (keys.has(key)) continue;
      if (capacity > 0) {
        capacity--;
        continue;
      }
      const victim = [...active]
        .sort((a, b) => b.started! - a.started!)
        .find(
          (j) =>
            j.automatic &&
            !j.controller.signal.aborted &&
            !manualKeys.has(j.key),
        );
      if (victim) this.interrupt(victim);
    }
  }

  private interrupt(job: Job) {
    logger.info("[local-server-check.queue] preempted", { key: job.key });
    this.cancel(job, preempted());
  }
  async shutdown() {
    this.stopped = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs)
      this.cancel(
        job,
        new DOMException("Inspector shutting down", "AbortError"),
      );
    await Promise.allSettled(jobs.map((j) => j.promise));
  }
}
export const localServerCheckQueue = new LocalServerCheckQueue();
// The local app session token is verified by sessionAuthMiddleware. Do not
// retain tokens in memory or accept a caller-supplied owner/principal. Bind
// promotion and duplicate IDs to the project bearer too; two signed-in accounts
// sharing one local process still cannot promote or read each other's requests.
export function localCheckOwner(c: Context) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        c.req.header("x-mcp-session-auth") ?? "local",
        c.req.header("authorization") ?? "",
      ]),
    )
    .digest("hex");
}
export function localCheckMetadata(value: unknown) {
  const v = value as { requestId?: unknown; intent?: unknown } | undefined;
  return {
    requestId:
      typeof v?.requestId === "string" && REQUEST_ID_PATTERN.test(v.requestId)
        ? v.requestId
        : randomUUID(),
    intent:
      v?.intent === "automatic" ? ("automatic" as const) : ("manual" as const),
  };
}
export async function promoteLocalServerCheck(c: Context) {
  const body = await c.req.json().catch(() => null);
  if (
    typeof body?.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(body.requestId)
  )
    return c.json({ code: "INVALID_REQUEST" }, 400);
  return c.json(
    localServerCheckQueue.promote(localCheckOwner(c), body.requestId),
  );
}
