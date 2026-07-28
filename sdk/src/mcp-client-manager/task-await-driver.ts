/**
 * `await` mode: drive a created task to a bounded terminal result.
 *
 * Used by automation surfaces — eval execution, the CLI's `tasks watch`, the
 * public API when a caller asks to block — where nobody is watching a tab, so
 * returning a handle for someone to follow later is the same as returning
 * nothing.
 *
 * Three properties, in the order they matter:
 *
 *  1. **It terminates.** Every exit is one of a small closed set, and the
 *     deadline is checked before every wait. A task that needs human input
 *     nobody can supply returns a deterministic `input-required` outcome
 *     rather than hanging until the evaluation times out — the plan's
 *     `TASK_INPUT_REQUIRED`.
 *  2. **It never polls faster than allowed.** Waiting is delegated to the
 *     lifecycle engine, so `pollIntervalMs`, the user minimum, error backoff
 *     and `Retry-After` all apply exactly as they do interactively. An
 *     automation surface has no licence the interactive one lacks.
 *  3. **It performs no I/O of its own.** The caller supplies `getTask` and
 *     `updateTask`, so this same driver runs over a local client, a hosted
 *     reconnect-per-poll route, or an HTTP API client.
 */

import {
  TaskLifecycleEngine,
  isTerminalLifecycleStatus,
  type TaskLifecycleIdentity,
  type TaskLifecycleObservation,
  type TaskLifecycleSnapshot,
} from "./task-lifecycle.js";
import { isUnknownTaskError } from "./task-lifecycle-adapters.js";
import {
  collectTaskInputResponses,
  type TaskInputDriverOptions,
  type TaskInputRejection,
} from "./task-input-driver.js";

/** How the drive ended. Every one is deterministic and reportable. */
export type TaskAwaitOutcome =
  /** Reached `completed`. `task` carries the inline result. */
  | "completed"
  /** Reached `failed` — a JSON-RPC fault, NOT a tool result with `isError`. */
  | "failed"
  /** Reached `cancelled`. */
  | "cancelled"
  /** A confirmed `tasks/get` `-32602`: the server no longer knows the handle. */
  | "expired"
  /** Needs input this surface cannot supply. The plan's `TASK_INPUT_REQUIRED`. */
  | "input-required"
  /** The deadline elapsed while the task was still working. */
  | "timeout"
  /** The caller's signal aborted. */
  | "aborted"
  /** Reads kept failing past the retry budget. */
  | "unreachable";

export interface TaskAwaitResult {
  outcome: TaskAwaitOutcome;
  /** Last validated state, when there was one. */
  task?: TaskLifecycleSnapshot;
  /** Input keys this surface could not answer, with reasons. */
  unansweredInput?: TaskInputRejection[];
  /** The read error that ended an `unreachable` drive. */
  lastError?: unknown;
}

export interface DriveTaskToTerminalArgs {
  identity: TaskLifecycleIdentity;
  /** Reads current state. Rejects with a `-32602` for an unknown handle. */
  getTask: (
    identity: TaskLifecycleIdentity
  ) => Promise<TaskLifecycleObservation>;
  /** Submits input responses. Resolving means the server acknowledged them. */
  updateTask?: (
    identity: TaskLifecycleIdentity,
    inputResponses: Record<string, unknown>
  ) => Promise<void>;
  /** Answers `input_required` rounds. Absent ⇒ any input ends the drive. */
  input?: TaskInputDriverOptions;
  /** Total wall-clock budget. The whole drive, not a single read. */
  timeoutMs?: number;
  /** Consecutive failed reads tolerated before giving up. */
  maxConsecutiveErrors?: number;
  /**
   * Cap on `input_required` rounds. A server that keeps asking for the same
   * thing must not turn a bounded drive into an unbounded one.
   */
  maxInputRounds?: number;
  signal?: AbortSignal;
  /**
   * Timer used to bound a single I/O call. Deliberately SEPARATE from
   * {@link sleep}: `sleep` is the poll-pacing clock a test drives by hand,
   * whereas this is a wall-clock watchdog that must not fire just because a
   * test advanced its own clock. Injected only so the watchdog itself is
   * testable.
   */
  setTimer?: (ms: number, fire: () => void) => () => void;
  /**
   * Injected engine. Pass the surface's own so an `await` drive shares the
   * schedule with whatever else is polling that server; omit for a private one.
   */
  engine?: TaskLifecycleEngine;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Observability hook. Never receives payloads — status transitions only. */
  onState?: (snapshot: TaskLifecycleSnapshot) => void;
}

/** Sentinels for {@link DriveTaskToTerminalArgs.setTimer}'s race outcomes. */
const TIMED_OUT = Symbol("task-await-timeout");
const ABORTED = Symbol("task-await-abort");

function defaultSetTimer(ms: number, fire: () => void): () => void {
  const handle = setTimeout(fire, ms);
  return () => clearTimeout(handle);
}

/** Terminal lifecycle status → drive outcome. One mapping, two exits. */
function terminalOutcome(status: string): TaskAwaitOutcome {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "expired";
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_MAX_INPUT_ROUNDS = 10;

/**
 * Polls `identity` until it reaches a terminal state or a bounded exit.
 *
 * The loop deliberately re-checks the deadline *before* sleeping rather than
 * after: a task whose advertised floor exceeds the remaining budget should
 * report `timeout` immediately instead of sleeping past its own deadline and
 * reporting it late.
 */
export async function driveTaskToTerminal(
  args: DriveTaskToTerminalArgs
): Promise<TaskAwaitResult> {
  const now = args.now ?? (() => Date.now());
  const sleep =
    args.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const setTimer = args.setTimer ?? defaultSetTimer;
  const engine = args.engine ?? new TaskLifecycleEngine({ now });
  const deadline = now() + (args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxErrors = args.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const maxInputRounds = args.maxInputRounds ?? DEFAULT_MAX_INPUT_ROUNDS;
  const { identity } = args;

  engine.register(identity, { restored: true });
  // Attaching to a SHARED engine must not jump the queue: if an interactive
  // poller read this handle a moment ago, its floor has not elapsed. A private
  // engine has `nextPollAt = now`, so the check below is a no-op there.
  let inputRounds = 0;
  let lastError: unknown;
  let unansweredInput: TaskInputRejection[] | undefined;

  for (;;) {
    if (args.signal?.aborted) {
      return { outcome: "aborted", task: engine.snapshot(identity) };
    }
    if (now() >= deadline) {
      return { outcome: "timeout", task: engine.snapshot(identity), lastError };
    }

    // Checked before EVERY dispatch, not just the first. On a shared engine an
    // interactive poller can reserve or re-read this handle while this drive
    // is sleeping, so a check that ran only once would let the second
    // iteration duplicate that read and breach the floor it just set.
    const existing = engine.get(identity);
    if (existing && isTerminalLifecycleStatus(existing.status)) {
      // Already finished, per whoever read it last. No read needed at all.
      const settled = engine.snapshot(identity)!;
      return { outcome: terminalOutcome(settled.status), task: settled };
    }
    if (existing && existing.nextPollAt > now()) {
      if (!(await waitUntilDue())) {
        return {
          outcome: "timeout",
          task: engine.snapshot(identity),
          lastError,
        };
      }
      continue;
    }
    // Reserve before dispatching, so a concurrent poller on the same engine
    // sees this handle as taken rather than issuing its own read.
    if (existing) engine.reserve([existing]);

    let observation: TaskLifecycleObservation;
    try {
      // BOUNDED, not a bare await. If the transport never settles — the exact
      // unreachable-server case this driver exists to handle — a bare await
      // would never return to the deadline or abort checks above, and a drive
      // configured with `timeoutMs` would hang forever. The bound is a real
      // timer rather than the injected `sleep`, so a test driving a controlled
      // clock is unaffected while production stays bounded.
      const bounded = await raceDeadline(args.getTask(identity));
      if (bounded === TIMED_OUT) {
        return {
          outcome: "timeout",
          task: engine.snapshot(identity),
          lastError,
        };
      }
      if (bounded === ABORTED) {
        return { outcome: "aborted", task: engine.snapshot(identity) };
      }
      observation = bounded;
    } catch (error) {
      lastError = error;
      // Only a `tasks/get` `-32602` retires a handle — that is the one method
      // carrying the MUST (`tasks.md:793-795`), and this IS a `tasks/get`.
      if (isUnknownTaskError(error)) {
        engine.markExpired(identity);
        const expired = engine.snapshot(identity);
        if (expired) args.onState?.(expired);
        return { outcome: "expired", task: expired };
      }
      const record = engine.observeError(identity);
      if (record.consecutiveErrors >= maxErrors) {
        return {
          outcome: "unreachable",
          task: engine.snapshot(identity),
          lastError,
        };
      }
      const waited = await waitUntilDue();
      if (!waited) {
        return {
          outcome: "timeout",
          task: engine.snapshot(identity),
          lastError,
        };
      }
      continue;
    }

    lastError = undefined;
    engine.observe(identity, observation);
    const snapshot = engine.snapshot(identity)!;
    args.onState?.(snapshot);

    if (isTerminalLifecycleStatus(snapshot.status)) {
      return { outcome: terminalOutcome(snapshot.status), task: snapshot };
    }

    if (snapshot.status === "input_required") {
      // No handlers, or no way to submit ⇒ this is exactly the deterministic
      // outcome the plan asks for, rather than a hang.
      if (!args.input || !args.updateTask) {
        return {
          outcome: "input-required",
          task: snapshot,
          unansweredInput,
        };
      }
      const pending = engine.pendingInputKeys(identity);
      if (pending.length === 0) {
        const keyedSnapshot = snapshot.inputRequests
          ? Object.keys(snapshot.inputRequests).length
          : 0;
        if (keyedSnapshot === 0) {
          // `input_required` with NO keyed requests at all. The 2025-11-25
          // wire is like this by construction: its `Task` carries no
          // `inputRequests`, and the request arrives out of band as an
          // elicitation stamped with `relatedTaskId`. There is nothing this
          // driver can ever answer, so report it rather than re-polling an
          // unchanging state until the deadline.
          return { outcome: "input-required", task: snapshot, unansweredInput };
        }
        // Every key in this snapshot is already answered. `tasks/update` is
        // eventually consistent, so wait for the next snapshot rather than
        // re-submitting.
        if (!(await waitUntilDue())) {
          return { outcome: "timeout", task: snapshot, lastError };
        }
        continue;
      }

      // Counted HERE, once we know there is genuinely something unanswered.
      // Counting on entry instead would spend the budget on already-answered
      // repeats: `tasks/update` is eventually consistent, so the same keyed
      // snapshot legitimately comes back several times while the server
      // catches up, and a slowly-converging task would report
      // `input-required` even though nothing was blocking it.
      if (++inputRounds > maxInputRounds) {
        return { outcome: "input-required", task: snapshot, unansweredInput };
      }

      const collected = await collectTaskInputResponses({
        options: args.input,
        taskId: identity.taskId,
        serverId: identity.serverId,
        inputRequests: (snapshot.inputRequests ?? {}) as never,
        respondedKeys: new Set(snapshot.respondedInputKeys),
        signal: args.signal,
      });
      unansweredInput = collected.rejections.length
        ? collected.rejections
        : undefined;

      if (collected.answeredKeys.length === 0) {
        // Nothing answerable and nothing left pending elsewhere: stop, and say
        // which keys blocked it.
        return {
          outcome: "input-required",
          task: snapshot,
          unansweredInput: collected.rejections,
        };
      }

      try {
        const ack = await raceDeadline(
          args.updateTask(
            identity,
            collected.responses as Record<string, unknown>
          )
        );
        if (ack === TIMED_OUT) {
          return { outcome: "timeout", task: snapshot, lastError };
        }
        if (ack === ABORTED) {
          return { outcome: "aborted", task: snapshot };
        }
        // Marked responded ONLY after the acknowledgement. An optimistic mark
        // would silently discard the answers if the update failed.
        engine.markInputKeysResponded(identity, collected.answeredKeys);
      } catch (error) {
        lastError = error;
        const record = engine.observeError(identity);
        if (record.consecutiveErrors >= maxErrors) {
          return { outcome: "unreachable", task: snapshot, lastError };
        }
      }
    }

    if (!(await waitUntilDue())) {
      return { outcome: "timeout", task: engine.snapshot(identity), lastError };
    }
  }

  /**
   * Resolves `work`, or one of the two sentinels if the deadline elapses or
   * the caller aborts first.
   *
   * The abandoned promise is deliberately left with a no-op rejection handler
   * rather than dropped: the underlying request may still fail later, and an
   * unhandled rejection from a call we stopped waiting on is noise, not a
   * signal.
   */
  /**
   * Resolves `work`, or one of the two sentinels if the deadline elapses or
   * the caller aborts first. This is what makes the drive bounded even when
   * the transport itself never settles.
   */
  async function raceDeadline<T>(
    work: Promise<T>
  ): Promise<T | typeof TIMED_OUT | typeof ABORTED> {
    // If the bound wins, nobody is left awaiting `work`. Attach a no-op
    // handler now so a later rejection from the call we stopped waiting on
    // does not surface as an unhandled rejection — it is noise, not a signal.
    work.catch(() => undefined);

    const remaining = deadline - now();
    if (remaining <= 0) return TIMED_OUT;
    if (args.signal?.aborted) return ABORTED;

    let cancelTimer: () => void = () => undefined;
    let onAbort: (() => void) | undefined;
    const bound = new Promise<typeof TIMED_OUT | typeof ABORTED>((resolve) => {
      cancelTimer = setTimer(remaining, () => resolve(TIMED_OUT));
      if (args.signal) {
        onAbort = () => resolve(ABORTED);
        args.signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    try {
      // `Promise.race` lets a genuine rejection from `work` propagate into the
      // caller's try/catch, so the backoff and `-32602` paths still see it.
      return await Promise.race([work, bound]);
    } finally {
      cancelTimer();
      if (onAbort) args.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Sleeps until this task is next due. Returns `false` when the deadline
   * would elapse first — checked BEFORE sleeping so a long advertised floor
   * cannot push the drive past its own budget.
   */
  async function waitUntilDue(): Promise<boolean> {
    const record = engine.get(identity);
    if (!record) return true;
    const delay = Math.max(0, record.nextPollAt - now());
    if (now() + delay >= deadline) return false;
    // Always yield, even at zero delay: an engine that keeps a task
    // perpetually due would otherwise spin this loop synchronously until the
    // deadline, starving the event loop — and under an injected clock that
    // only advances on `sleep`, never terminating at all.
    await sleep(delay);
    return true;
  }
}
