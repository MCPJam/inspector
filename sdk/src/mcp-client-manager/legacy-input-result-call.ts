/**
 * 2025-11-25: the one `tasks/result` a drive sends when a task asks for input.
 *
 * "When the requestor encounters the `input_required` status, it SHOULD
 * preemptively call `tasks/result`" (tasks.mdx:449). That open call is where
 * the server delivers its questions, and it only answers once the task has
 * ended (tasks.mdx:465), with exactly what the task's request returned
 * (tasks.mdx:466).
 *
 * The pure parts of that call live here; `driveTaskToTerminal` makes the call
 * and keeps what it brought.
 */

import type {
  TaskLifecycleError,
  TaskLifecycleSnapshot,
} from "./task-lifecycle.js";
import { isUnknownTaskError } from "./task-lifecycle-adapters.js";

/** How long the call stays open when the caller does not say. */
export const DEFAULT_INPUT_REQUIRED_RESULT_WAIT_MS = 5_000;

/**
 * How long the call may stay open, and whether the deadline is what would
 * end it. Only a caller that asked to wait for an answer can run into the
 * deadline. With the short default, an unanswered call means "nobody here can
 * answer", whichever bound was tighter.
 */
export function inputCallWait(
  callerWaitMs: number | undefined,
  remainingMs: number
): { waitMs: number; deadlineBound: boolean } {
  return {
    waitMs: Math.min(
      callerWaitMs ?? DEFAULT_INPUT_REQUIRED_RESULT_WAIT_MS,
      remainingMs
    ),
    deadlineBound: callerWaitMs !== undefined && callerWaitMs >= remainingMs,
  };
}

/**
 * The server's JSON-RPC error answer to the call, or `undefined` when the
 * error is the client's own. A numeric code is a JSON-RPC error, so the server
 * answered: the task ended without completing. This client's own errors carry
 * string codes (`REQUEST_TIMEOUT`, `CONNECTION_CLOSED`, an HTTP failure's
 * `CLIENT_HTTP_*`).
 */
export function serverErrorAnswer(
  error: unknown
): TaskLifecycleError | undefined {
  const { code, message, data } = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
  if (typeof code !== "number") return undefined;
  return {
    code,
    message: typeof message === "string" ? message : String(error),
    ...(data !== undefined ? { data } : {}),
  };
}

/**
 * The task as the call's answer settles it, for an exit the server did not
 * confirm:
 * - a result: `failed` when it is a tool error (`isError`, as the 2025-11-25
 *   statuses define it, tasks.mdx:721), else `completed`;
 * - a JSON-RPC error: `failed`, with that error. Except `-32602`, which on
 *   `tasks/result` can also mean the task id is unknown (tasks.mdx:768), so
 *   it is no proof the task failed.
 *
 * `undefined` when the call brought nothing to settle from.
 */
export function settleFromInputCall(
  last: TaskLifecycleSnapshot,
  result: Record<string, unknown> | undefined,
  error: TaskLifecycleError | undefined
): TaskLifecycleSnapshot | undefined {
  if (result) {
    const status = result.isError === true ? "failed" : "completed";
    return { ...last, status, result };
  }
  if (error && !isUnknownTaskError(error)) {
    return { ...last, status: "failed", error };
  }
  return undefined;
}
