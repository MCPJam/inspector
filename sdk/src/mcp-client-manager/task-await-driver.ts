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
  getTask: (identity: TaskLifecycleIdentity) => Promise<TaskLifecycleObservation>;
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
   * Injected engine. Pass the surface's own so an `await` drive shares the
   * schedule with whatever else is polling that server; omit for a private one.
   */
  engine?: TaskLifecycleEngine;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Observability hook. Never receives payloads — status transitions only. */
  onState?: (snapshot: TaskLifecycleSnapshot) => void;
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
  const engine = args.engine ?? new TaskLifecycleEngine({ now });
  const deadline = now() + (args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxErrors = args.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const maxInputRounds = args.maxInputRounds ?? DEFAULT_MAX_INPUT_ROUNDS;
  const { identity } = args;

  engine.register(identity, { restored: true });
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

    let observation: TaskLifecycleObservation;
    try {
      observation = await args.getTask(identity);
    } catch (error) {
      lastError = error;
      // Only a `tasks/get` `-32602` retires a handle — that is the one method
      // carrying the MUST (`tasks.md:793-795`), and this IS a `tasks/get`.
      if (isUnknownTaskError(error)) {
        const record = engine.markExpired(identity);
        args.onState?.(engine.snapshot(identity)!);
        void record;
        return { outcome: "expired", task: engine.snapshot(identity) };
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
        return { outcome: "timeout", task: engine.snapshot(identity), lastError };
      }
      continue;
    }

    lastError = undefined;
    engine.observe(identity, observation);
    const snapshot = engine.snapshot(identity)!;
    args.onState?.(snapshot);

    if (isTerminalLifecycleStatus(snapshot.status)) {
      return {
        outcome:
          snapshot.status === "completed"
            ? "completed"
            : snapshot.status === "failed"
              ? "failed"
              : snapshot.status === "cancelled"
                ? "cancelled"
                : "expired",
        task: snapshot,
      };
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
      if (++inputRounds > maxInputRounds) {
        return { outcome: "input-required", task: snapshot, unansweredInput };
      }

      const pending = engine.pendingInputKeys(identity);
      if (pending.length === 0) {
        // Everything in this snapshot is already answered; `tasks/update` is
        // eventually consistent, so wait for the next one rather than
        // re-submitting.
        if (!(await waitUntilDue())) {
          return { outcome: "timeout", task: snapshot, lastError };
        }
        continue;
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
        await args.updateTask(
          identity,
          collected.responses as Record<string, unknown>
        );
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
   * Sleeps until this task is next due. Returns `false` when the deadline
   * would elapse first — checked BEFORE sleeping so a long advertised floor
   * cannot push the drive past its own budget.
   */
  async function waitUntilDue(): Promise<boolean> {
    const record = engine.get(identity);
    if (!record) return true;
    const delay = Math.max(0, record.nextPollAt - now());
    if (now() + delay >= deadline) return false;
    if (delay > 0) await sleep(delay);
    return true;
  }
}
