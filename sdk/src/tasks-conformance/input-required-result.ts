/**
 * What a 2025-11-25 client does when a task parks on `input_required`.
 *
 * "When the requestor encounters the `input_required` status, it SHOULD
 * preemptively call `tasks/result`." On that wire the call is how the client
 * receives the server's input requests: the server holds the response open and
 * delivers them on its stream, then answers once the task has ended.
 *
 * The suite has no answers to give on this wire, so the call is bounded. A
 * server that is waiting for an answer holds it open for as long as it likes.
 *
 * The extension wire has no `tasks/result`: its input requests ride on
 * `tasks/get` and are answered with `tasks/update`.
 */

import { REQUEST_TIMEOUT, type RawRequest } from "./evidence.js";
import { errorCode, errorMessage } from "./metadata.js";

/**
 * How long the call may stay open. Long enough for a server to deliver its
 * input requests or to end the task on its own, short enough that a task
 * nobody can answer does not spend the whole poll budget. The same bound the
 * suite gives the other request a server may hold open (`subscriptions/listen`).
 */
export const INPUT_REQUIRED_RESULT_WAIT_MS = 5_000;

/** The bound for one run: never more than the run's own poll budget. */
export function inputRequiredResultWaitMs(pollTimeoutMs: number): number {
  return Math.max(0, Math.min(INPUT_REQUIRED_RESULT_WAIT_MS, pollTimeoutMs));
}

export type InputRequiredResultCall =
  /** The server returned a result. It only does that once the task has ended. */
  | { outcome: "returned"; waitedMs: number }
  /** The server answered with a JSON-RPC error: the task failed, or it refused. */
  | { outcome: "error"; code: number; message: string; waitedMs: number }
  /** Nothing came back in time. The task is as it was. */
  | { outcome: "no-answer"; message: string; waitedMs: number };

/**
 * Send one `tasks/result` for a task parked on `input_required`.
 *
 * `request` must send exactly once. A retrying caller would turn one bounded
 * wait into several, and put several `tasks/result` on the wire.
 */
export async function callResultWhileInputRequired(options: {
  request: RawRequest;
  taskId: string;
  timeoutMs: number;
}): Promise<InputRequiredResultCall> {
  const startedAt = Date.now();
  try {
    await options.request(
      { method: "tasks/result", params: { taskId: options.taskId } },
      { timeout: options.timeoutMs }
    );
    return { outcome: "returned", waitedMs: Date.now() - startedAt };
  } catch (error) {
    const waitedMs = Date.now() - startedAt;
    const code = errorCode(error);
    // The client's own timeout carries -32001. Any other number is the
    // server's answer, and it only answers once the task has ended.
    if (code !== undefined && code !== REQUEST_TIMEOUT) {
      return { outcome: "error", code, message: errorMessage(error), waitedMs };
    }
    return { outcome: "no-answer", message: errorMessage(error), waitedMs };
  }
}

/** `details` for a check that reports on a task this call was made for. */
export function describeResultCall(
  call: InputRequiredResultCall
): Record<string, unknown> {
  return {
    outcome: call.outcome,
    waitedMs: call.waitedMs,
    ...(call.outcome === "error" ? { code: call.code } : {}),
    ...(call.outcome === "returned" ? {} : { message: call.message }),
  };
}
