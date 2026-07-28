/**
 * The single task-creation fan-out point, and the `await`-mode driver.
 *
 * ## Why one event
 *
 * A created task has to reach four places at once: the durable browser
 * tracker, the hosted chat stream, the best-effort hosted registry, and
 * analytics. Before this, each execution surface wired its own subset, which
 * is how a task created from chat could end up untracked while the same task
 * created from the Tools tab was tracked. {@link TaskCreatedSink} makes the
 * fan-out the thing surfaces share, so adding a consumer is one registration
 * rather than an edit in every route.
 *
 * Two rules the sink enforces, from the plan:
 *
 *  1. **A registry failure must never convert a successful tool call into a
 *     failure.** The task exists on the server whether or not we managed to
 *     write a recovery row. Throwing here would tell the user their call
 *     failed while the work runs on regardless.
 *  2. **Tracking and client delivery are functional paths, not fire-and-forget.**
 *     They are awaited, and a failure in one is reported rather than swallowed
 *     inside an unobserved promise. "Best effort" describes the *registry*, not
 *     the local tracker the user's next page load depends on.
 */

import type { LiveTasksWire, TaskLifecycleIdentity } from "./task-lifecycle.js";

/** Where a task was created from. Mirrors the host-policy surface matrix. */
export type TaskCreationSurface =
  | "tools"
  | "chat"
  | "agent"
  | "eval"
  | "conformance"
  | "api"
  | "cli";

/**
 * A task handle, the moment it comes into existence.
 *
 * Deliberately carries no result, no input requests, and no tool arguments:
 * consumers of this event persist and route, they do not render. Anything
 * richer is read back from `tasks/get` by whoever actually needs it.
 */
export interface TaskCreatedEvent {
  identity: TaskLifecycleIdentity;
  wire: LiveTasksWire;
  surface: TaskCreationSurface;
  /** ISO timestamp reported by the server, not a local clock reading. */
  createdAt?: string;
  ttlMs?: number | null;
  pollIntervalMs?: number;
  /** The tool whose call produced this task, when the surface knows it. */
  toolName?: string;
  status?: string;
}

/** One registered consumer. */
export interface TaskCreatedConsumer {
  name: string;
  /**
   * `false` (the default) means a throw from this consumer propagates: it is a
   * functional path — durable tracking, client event delivery — and a silent
   * failure there loses the handle.
   *
   * `true` means a throw is captured and reported instead: for the hosted
   * registry, which is a recovery index rather than the source of truth.
   */
  bestEffort?: boolean;
  handle: (event: TaskCreatedEvent) => void | Promise<void>;
}

/** A consumer that failed. Reported, never silently dropped. */
export interface TaskCreatedConsumerFailure {
  name: string;
  error: unknown;
}

export interface TaskCreatedDispatchResult {
  /** Failures from `bestEffort` consumers. Non-empty is not an error. */
  degraded: TaskCreatedConsumerFailure[];
}

/**
 * How long a `bestEffort` consumer may take before the fan-out stops waiting
 * for it. "Best effort" has to mean bounded effort: a registry write that
 * hangs rather than failing would otherwise leave `dispatch()` pending
 * forever, and a caller awaiting it would never return a tool call that
 * already succeeded on the server.
 */
export const DEFAULT_BEST_EFFORT_TIMEOUT_MS = 5_000;

/**
 * Fan-out for {@link TaskCreatedEvent}.
 *
 * Consumers run in registration order and are awaited. Order matters for one
 * reason: durable local tracking should land before anything that might be
 * slow or remote, so a hung registry write cannot cost the user their handle.
 */
export class TaskCreatedSink {
  private readonly consumers: TaskCreatedConsumer[] = [];

  constructor(
    private readonly bestEffortTimeoutMs = DEFAULT_BEST_EFFORT_TIMEOUT_MS
  ) {}

  register(consumer: TaskCreatedConsumer): () => void {
    this.consumers.push(consumer);
    return () => {
      const index = this.consumers.indexOf(consumer);
      if (index >= 0) this.consumers.splice(index, 1);
    };
  }

  /**
   * Delivers to every consumer.
   *
   * @throws whatever a non-`bestEffort` consumer throws — those are the paths
   * whose failure genuinely means the handle was lost.
   */
  async dispatch(event: TaskCreatedEvent): Promise<TaskCreatedDispatchResult> {
    const degraded: TaskCreatedConsumerFailure[] = [];
    // Functional failures are collected rather than thrown from inside the
    // loop. Throwing on the first one skipped every consumer after it, so a
    // tracker write that failed took the stream part and the registry record
    // down with it — silently, and in registration order, which is not a
    // meaningful priority. Delivery is attempted to EVERY consumer; the throw
    // happens once, below, after they have all had their turn.
    const fatal: TaskCreatedConsumerFailure[] = [];
    // Iterate a COPY: a consumer that unregisters itself (or a sibling) while
    // we are awaiting it would shift the indices under a live iterator and the
    // next consumer would be silently skipped.
    for (const consumer of [...this.consumers]) {
      try {
        if (consumer.bestEffort) {
          // Bounded: a hang is degradation, exactly like a throw.
          const timedOut = await withTimeout(
            Promise.resolve(consumer.handle(event)),
            this.bestEffortTimeoutMs
          );
          if (timedOut) {
            degraded.push({
              name: consumer.name,
              error: new Error(
                `${consumer.name} did not settle within ${this.bestEffortTimeoutMs}ms`
              ),
            });
          }
          continue;
        }
        await consumer.handle(event);
      } catch (error) {
        if (!consumer.bestEffort) {
          fatal.push({ name: consumer.name, error });
          continue;
        }
        // The task is running on the server regardless of whether we recorded
        // a recovery row for it. Reporting this is right; failing the call is
        // not.
        degraded.push({ name: consumer.name, error });
      }
    }
    if (fatal.length === 1) {
      // Rethrown unchanged: a lone functional failure should surface exactly
      // as the consumer threw it, stack and type intact.
      throw fatal[0].error;
    }
    if (fatal.length > 1) {
      throw new AggregateError(
        fatal.map((failure) => failure.error),
        `${fatal.length} task-created consumers failed: ${fatal
          .map((failure) => failure.name)
          .join(", ")}`
      );
    }
    return { degraded };
  }
}

/**
 * Resolves `false` when `work` settled in time, `true` when it did not.
 *
 * A rejection propagates so the caller's own `catch` still classifies it. The
 * abandoned promise keeps a no-op handler for the timeout case, since a late
 * failure from a call nobody is waiting on is noise.
 */
async function withTimeout(
  work: Promise<unknown>,
  ms: number
): Promise<boolean> {
  if (!Number.isFinite(ms) || ms <= 0) {
    await work;
    return false;
  }
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
  });
  try {
    return (
      (await Promise.race([work.then(() => false as const), timeout])) === true
    );
  } finally {
    clearTimeout(timer!);
    work.catch(() => undefined);
  }
}
