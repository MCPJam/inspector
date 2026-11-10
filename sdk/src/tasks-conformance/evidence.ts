import { z } from "zod";

import {
  MCP_ERROR_CODES,
  PRE_RENUMBER_DRAFT_ERROR_CODES,
} from "../mcp-client-manager/mcp-error-codes.js";

import { TASK_CREATED_META_KEY } from "../mcp-client-manager/transport-utils.js";

import {
  isRecord,
  errorMessage,
  readRequiredCapabilities,
  errorCode,
} from "./metadata.js";
import { ShapeVerdict, TASK_STATUSES } from "./shapes.js";
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export const PARKED_INPUT_REQUIRED_POLLS = 3;

export const MISSING_REQUIRED_CLIENT_CAPABILITY =
  MCP_ERROR_CODES.MissingRequiredClientCapability;

export const OBSOLETE_MISSING_REQUIRED_CLIENT_CAPABILITY =
  PRE_RENUMBER_DRAFT_ERROR_CODES.MissingRequiredClientCapability;

export const METHOD_NOT_FOUND = -32601;

export const INVALID_PARAMS = MCP_ERROR_CODES.InvalidParams;

export const REQUEST_TIMEOUT = -32001;

export const LISTEN_PROBE_TIMEOUT_MS = 5_000;

export type UndeclaredProbeOutcome =
  /** Rejected with -32021: the required behavior. */
  | "rejected"
  /** The server served the request. */
  | "answered"
  /** Rejected, but with some other error code. */
  | "wrong-code"
  /** No answer arrived before the probe's own deadline. */
  | "no-response"
  /**
   * The request never reached the server at all — it died locally (upstream's
   * outbound era gate, a missing result schema) or the transport failed before
   * a JSON-RPC response existed. NOT a verdict on the server, and never a pass:
   * a probe that cannot execute must not be reported as conformance.
   */
  | "probe-failed"
  /** -32601: the method does not exist here, so the rule cannot be probed. */
  | "unsupported";

export interface UndeclaredProbe {
  method: string;
  outcome: UndeclaredProbeOutcome;
  code?: number;
  message?: string;
  /**
   * `error.data.requiredCapabilities` off a `-32021` rejection, when the server
   * named them. Absent for every other outcome.
   */
  requiredCapabilities?: unknown;
  /**
   * Whether an outbound JSON-RPC request for this method was observed on the
   * connection's rpc log. This is what separates "the server misbehaved" from
   * "the probe never got onto the wire".
   */
  reachedWire?: boolean;
}

export function describeUndeclaredProbe(probe: UndeclaredProbe): string {
  switch (probe.outcome) {
    case "answered":
      return `${probe.method} was answered instead of rejected`;
    case "wrong-code":
      return probe.code === OBSOLETE_MISSING_REQUIRED_CLIENT_CAPABILITY
        ? `${probe.method} was rejected with -32003, the code the tasks extension carried before it was corrected to -32021; the server is running against a pre-final draft`
        : `${probe.method} was rejected with ${probe.code} rather than -32021`;
    case "no-response":
      return `${probe.method} produced no JSON-RPC rejection (${
        probe.message ?? "no answer"
      }); a conforming server refuses it immediately with -32021`;
    case "probe-failed":
      return `${probe.method} never reached the server (${
        probe.message ?? "no answer"
      }), so the undeclared-request requirement was NOT tested`;
    case "unsupported":
      return `${probe.method} is not implemented (-32601)`;
    case "rejected":
      return `${probe.method} was rejected with -32021`;
  }
}

export interface RawTaskResponse {
  taskId: string;
  /** Exactly as it arrived: `undefined` means the key was absent. */
  resultType: unknown;
  /** Whether the required `resultType: "task"` discriminator was present. */
  discriminated: boolean;
}

export function findRawResult(
  messages: unknown[]
): Record<string, unknown> | undefined {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (isRecord(message.result)) return message.result;
  }
  return undefined;
}

export function findRawTaskResponse(
  messages: unknown[]
): RawTaskResponse | undefined {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const result = isRecord(message.result) ? message.result : undefined;
    if (!result) continue;
    if (typeof result.taskId !== "string" || result.taskId.length === 0) {
      continue;
    }
    return {
      taskId: result.taskId,
      resultType: result.resultType,
      discriminated: result.resultType === "task",
    };
  }
  return undefined;
}

export function findRawTaskStates(
  messages: unknown[],
  taskId: string,
  /**
   * JSON-RPC ids of the `tasks/get` requests this run sent. REQUIRED for
   * correctness, not an optimization: a `CreateTaskResult` from `tools/call` is
   * a bare `Task` carrying `taskId` and `status` and — entirely correctly — no
   * `result`, `error` or `inputRequests`. Matching on shape alone would sweep
   * it in, so a server that creates an already-`completed` (or `failed`, or
   * `input_required`) task would fail the status-payload check even when every
   * `tasks/get` it later answers is perfectly formed.
   *
   * The status payload rules are stated for `tasks/get` responses; grading a
   * creation frame against them invents a requirement.
   */
  getRequestIds: ReadonlySet<string>
): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const result = isRecord(message.result) ? message.result : undefined;
    if (!result) continue;
    if (result.taskId !== taskId) continue;
    // Deliberately NOT filtered on `status`. A missing or non-string status is
    // a VIOLATION of the extension's `Task` (where `status` is required and a
    // closed enum), and dropping such a frame here turned that violation into a
    // non-observation: the check then reported `could-not-run` — "we never saw
    // a task state" — about a server that answered with a malformed one.
    //
    // Identification is safe without it: membership in `getRequestIds` below
    // already establishes that this is a `tasks/get` response, and a
    // `tasks/get` response IS a Task.
    const id = message.id;
    if (
      (typeof id !== "string" && typeof id !== "number") ||
      !getRequestIds.has(String(id))
    ) {
      continue;
    }
    found.push(result);
  }
  return found;
}

export function findRawCreationTask(
  messages: unknown[],
  taskId: string,
  toolsCallRequestIds: ReadonlySet<string>
): Record<string, unknown> | undefined {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const result = isRecord(message.result) ? message.result : undefined;
    if (!result || result.taskId !== taskId) continue;
    const id = message.id;
    if (
      (typeof id === "string" || typeof id === "number") &&
      toolsCallRequestIds.has(String(id))
    ) {
      return result;
    }
  }
  return undefined;
}

export function isRawTaskShaped(result: Record<string, unknown>): boolean {
  if (result.resultType === "task") return true;
  return (
    typeof result.status === "string" &&
    TASK_STATUSES.has(result.status) &&
    !Array.isArray(result.content)
  );
}

export function sentRequestIds(sent: unknown[], method: string): Set<string> {
  const ids = new Set<string>();
  for (const message of sent) {
    if (!isRecord(message)) continue;
    if (message.method !== method) continue;
    const id = message.id;
    if (typeof id === "string" || typeof id === "number") {
      ids.add(String(id));
    }
  }
  return ids;
}

export function describeUndiscriminatedTask(raw: RawTaskResponse): string {
  return `the server answered a tools/call with a flat task payload (taskId ${JSON.stringify(
    raw.taskId
  )}) that does not carry resultType "task"${
    raw.resultType === undefined
      ? ""
      : ` (got ${JSON.stringify(raw.resultType)})`
  }; tasks.md:102 makes that discriminator a MUST because it is the ONLY signal separating a CreateTaskResult from a standard result. This client decoded the response as an ordinary tool result, so the task is UNREACHABLE: it is never tracked, and the work runs to completion server-side with no handle to poll, cancel, or read`;
}

export function extractUndeclaredCreationTaskId(
  result: unknown
): string | undefined {
  if (!isRecord(result)) return undefined;
  if (typeof result.taskId === "string" && result.taskId.length > 0) {
    return result.taskId;
  }
  const meta = isRecord(result._meta) ? result._meta : undefined;
  const stashed = meta?.[TASK_CREATED_META_KEY];
  if (!isRecord(stashed)) return undefined;
  // A `taskId`-less stash is still a task the server created; name it rather
  // than let the absent id downgrade the failure to a pass.
  return typeof stashed.taskId === "string" && stashed.taskId.length > 0
    ? stashed.taskId
    : "(CreateTaskResult with no taskId)";
}

export type RawRequest = (
  payload: { method: string; params: Record<string, unknown> },
  options?: { timeout?: number }
) => Promise<unknown>;

export const RAW_PROBE_RESULT_SCHEMA = z.looseObject({});

export function countSentRequests(sent: unknown[], method: string): number {
  return sent.filter(
    (message) => isRecord(message) && message.method === method
  ).length;
}

export async function runUndeclaredProbe(
  request: RawRequest,
  sent: unknown[],
  method: string,
  params: Record<string, unknown>,
  options?: { timeout?: number; listenProbe?: boolean }
): Promise<UndeclaredProbe> {
  const sentBefore = countSentRequests(sent, method);
  const reachedWire = () => countSentRequests(sent, method) > sentBefore;
  try {
    await request(
      { method, params },
      options?.timeout === undefined ? undefined : { timeout: options.timeout }
    );
    return { method, outcome: "answered", reachedWire: reachedWire() };
  } catch (error) {
    const code = errorCode(error);
    const message = errorMessage(error);
    if (code === MISSING_REQUIRED_CLIENT_CAPABILITY) {
      return {
        method,
        outcome: "rejected",
        code,
        reachedWire: true,
        // Kept for the sibling check that asks whether the rejection NAMES the
        // capability. The core schema requires `error.data.requiredCapabilities`
        // on this error, our own protocol check already asserts it, and nothing
        // in the tasks suite looked at it.
        requiredCapabilities: readRequiredCapabilities(error),
      };
    }
    if (code === METHOD_NOT_FOUND && options?.listenProbe) {
      return {
        method,
        outcome: "unsupported",
        code,
        message,
        reachedWire: true,
      };
    }
    if (code === undefined) {
      // No JSON-RPC response exists, so there is no server verdict. The rpc log
      // decides which kind of nothing this is: a request that DID leave the
      // process and was never answered (a stream the server held open past the
      // probe deadline) is a server-side `no-response`; one that never left is
      // the probe's own failure and must not be graded as conformance.
      return reachedWire()
        ? { method, outcome: "no-response", message, reachedWire: true }
        : { method, outcome: "probe-failed", message, reachedWire: false };
    }
    if (code === REQUEST_TIMEOUT) {
      // A server-sent -32001: the request reached it and it declined to answer
      // within the deadline — a verdict, just not the required one.
      return {
        method,
        outcome: "no-response",
        code,
        message,
        reachedWire: true,
      };
    }
    return { method, outcome: "wrong-code", code, message, reachedWire: true };
  }
}

export interface InputRequiredLeg {
  outcome: "no-responses-configured" | "update-rejected" | "updated";
  /** Keys the task asked the client to answer. */
  requested: string[];
  /** Keys the operator supplied. */
  answered?: string[];
  message?: string;
  code?: number;
  /**
   * On a rejection: why the configured answers could not satisfy the task
   * (missing, extra, or failing its `requestedSchema`), when we can tell.
   */
  answersProblem?: string;
  /** Result members beyond the envelope; a conforming ack has none. */
  ackVerdict?: ShapeVerdict;
}
