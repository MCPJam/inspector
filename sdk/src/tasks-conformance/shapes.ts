import type { TasksWire } from "../mcp-client-manager/tasks-dispatch.js";

import { isRecord } from "./metadata.js";

export interface ShapeVerdict {
  violations: string[];
  warnings: string[];
}

export function validateCreateTaskShape(result: unknown): ShapeVerdict {
  const violations: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(result)) {
    return { violations: ["task creation result must be an object"], warnings };
  }
  if (result.resultType !== "task") {
    violations.push(
      result.resultType === undefined
        ? 'task creation result carries no resultType "task" discriminator, the only signal that distinguishes it from a standard result; a client reads it as an ordinary tool result and never tracks the task'
        : `task creation result must carry resultType "task" (got ${JSON.stringify(
            result.resultType
          )})`
    );
  }
  if (typeof result.taskId !== "string" || result.taskId.length === 0) {
    violations.push(
      "task creation result must carry a server-generated taskId"
    );
  }
  return { violations, warnings };
}

export function validateTaskTtlShape(
  wire: TasksWire,
  task: unknown
): ShapeVerdict {
  if (!isRecord(task)) {
    return { violations: ["task payload must be an object"], warnings: [] };
  }
  const violations: string[] = [];
  const warnings: string[] = [];

  if (wire === "extension") {
    const ttlMs = task.ttlMs;
    if (!(ttlMs === null || typeof ttlMs === "number")) {
      violations.push(
        `extension task ttlMs must be a number or null (got ${JSON.stringify(
          ttlMs
        )})`
      );
    }
    if (
      task.pollIntervalMs !== undefined &&
      typeof task.pollIntervalMs !== "number"
    ) {
      violations.push("extension task pollIntervalMs must be a number");
    }
  } else {
    if (task.ttl !== undefined && typeof task.ttl !== "number") {
      violations.push("legacy task ttl must be a number when present");
    }
    if (
      task.pollInterval !== undefined &&
      typeof task.pollInterval !== "number"
    ) {
      violations.push("legacy task pollInterval must be a number");
    }
  }

  return { violations, warnings };
}

export function validateCompletionAck(
  ack: unknown,
  method: string,
  /**
   * The acknowledgement AS IT ARRIVED, read off the rpc log rather than from
   * the client's return value. `resultType` is a wire-only member the v2 client
   * consumes on the way through, so the decoded `ack` cannot answer whether the
   * server sent it — only this can. Absent when the frame could not be
   * correlated, and then the member is not judged.
   */
  rawAck?: Record<string, unknown>
): ShapeVerdict {
  // A non-object is not an empty result, it is not a result at all. This was
  // the hole: the update path read `isRecord(ack) ? keys : []` and an ack of
  // `"ok"` produced an empty extras list, i.e. a PASS from the check whose job
  // is to confirm the server acknowledged properly.
  if (!isRecord(ack)) {
    return {
      violations: [
        `${method} did not return a result object (got ${
          ack === null ? "null" : typeof ack
        })`,
      ],
      warnings: [],
    };
  }
  const violations: string[] = [];
  const extras = Object.keys(ack).filter(
    (key) => key !== "resultType" && key !== "_meta"
  );
  if (extras.length > 0) {
    violations.push(
      `the acknowledgement carried ${JSON.stringify(
        extras
      )}; the extension requires an empty result and the client re-polls for the new status`
    );
  }
  // `resultType` is judged from the RAW frame when there is one. This used to
  // defer to `wire-schema-valid` on the grounds that it grades these frames
  // against `UpdateTaskResult` / `CancelTaskResult`, which mark the member
  // required — but it never sees them: the Tasks suite runs its own runner,
  // and that runner installs no `WireObservationRecorder` and runs no wire
  // check. So the requirement had no verdict in any suite, and a missing
  // required member read as a pass.
  //
  // It cannot be judged from the decoded `ack` either — the v2 client consumes
  // `resultType` on the way through, so a conforming server's ack arrives here
  // without it. Reading the rpc log is the same move `tasks-status-payload-shape`
  // already makes, and for the same reason. With no raw frame a missing member
  // is not judged: every connection is rpc-logged, so that should not happen,
  // and blaming the server for what our own client stripped would be wrong.
  const observed = rawAck ?? (ack as Record<string, unknown>);
  const canJudgeResultType = rawAck !== undefined;
  const resultTypeName =
    method === "tasks/cancel" ? "CancelTaskResult" : "UpdateTaskResult";

  if (observed.resultType === undefined) {
    if (canJudgeResultType) {
      violations.push(
        `the acknowledgement omits resultType "complete"; the extension's ${resultTypeName} marks it required`
      );
    }
  } else if (observed.resultType !== "complete") {
    // Present but WRONG is a different fact from absent: a client
    // discriminates on this member, so a wrong value actively misdirects it.
    violations.push(
      `the acknowledgement carried resultType ${JSON.stringify(
        observed.resultType
      )} rather than "complete"`
    );
  }
  return { violations, warnings: [] };
}

export const TASK_STATUSES = new Set([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);

export function validateTaskStatusPayload(task: unknown): ShapeVerdict {
  if (!isRecord(task)) {
    return { violations: ["task payload must be an object"], warnings: [] };
  }
  const violations: string[] = [];
  const warnings: string[] = [];

  // `Task.status` is REQUIRED and a closed enum of five values in the
  // extension's schema. Reading it through `String(...)` accepted anything:
  // `undefined` became the string "undefined", `42` became "42", and both fell
  // through the switch's `default` to a silent pass — as did a plausible-looking
  // typo like "complete" or "in_progress". A client discriminates on this field,
  // so a status it cannot recognise is not a cosmetic problem.
  if (typeof task.status !== "string") {
    return {
      violations: [
        task.status === undefined
          ? "a task must carry the required `status` field"
          : `a task's \`status\` must be a string, got ${typeof task.status}`,
      ],
      warnings: [],
    };
  }
  const status = task.status;
  if (!TASK_STATUSES.has(status)) {
    violations.push(
      `a task's \`status\` must be one of ${[...TASK_STATUSES].join(", ")}; got ${JSON.stringify(status)}`
    );
  }

  switch (status) {
    case "completed":
      if (task.result === undefined) {
        violations.push(
          "a completed task must carry the `result` field with the final result of the request"
        );
      }
      break;
    case "failed":
      if (!isRecord(task.error)) {
        violations.push(
          "a failed task must carry the `error` field with the JSON-RPC error that occurred"
        );
      } else if (typeof task.error.code !== "number") {
        violations.push("a failed task's `error` must carry a numeric code");
      }
      // The `statusMessage` SHOULD is advice, not a payload requirement: see
      // {@link failedTaskLacksStatusMessage}.
      break;
    case "input_required":
      if (!isRecord(task.inputRequests)) {
        violations.push(
          "an input_required task must carry `inputRequests` naming what the client has to answer; without it the task can never proceed"
        );
      } else if (Object.keys(task.inputRequests).length === 0) {
        violations.push(
          "an input_required task carries an empty `inputRequests`; it must contain all outstanding requests"
        );
      }
      break;
    default:
      break;
  }

  return { violations, warnings };
}

export function failedTaskLacksStatusMessage(task: unknown): boolean {
  return (
    isRecord(task) &&
    task.status === "failed" &&
    task.statusMessage === undefined
  );
}

export function validateTaskTtlIntegerShape(
  wire: TasksWire,
  task: unknown
): ShapeVerdict {
  if (!isRecord(task)) {
    return { violations: ["task payload must be an object"], warnings: [] };
  }
  const violations: string[] = [];
  const warnings: string[] = [];

  const fields =
    wire === "extension"
      ? ([
          ["ttlMs", task.ttlMs],
          ["pollIntervalMs", task.pollIntervalMs],
        ] as const)
      : ([
          ["ttl", task.ttl],
          ["pollInterval", task.pollInterval],
        ] as const);

  for (const [name, value] of fields) {
    if (value === undefined || value === null) continue;
    // The era-native TYPE is `tasks-ttl-shape`'s subject, not this check's.
    if (typeof value !== "number") continue;
    if (!Number.isInteger(value)) {
      violations.push(`${name} is ${value}, which is not an integer`);
      continue;
    }
    // schema.json bounds both fields to ±9007199254740991, the safe-integer
    // range, so a larger whole number is out of schema too.
    if (!Number.isSafeInteger(value)) {
      violations.push(
        `${name} is ${value}, which is outside the schema's integer range`
      );
      continue;
    }
  }

  return { violations, warnings };
}

export async function captureTaskRequestHeaders(
  fn: () => Promise<unknown>
): Promise<{ headers?: Record<string, string>; error?: unknown }> {
  const original = globalThis.fetch;
  let headers: Record<string, string> | undefined;

  globalThis.fetch = (async (input: any, init?: any) => {
    const seen: Record<string, string> = {};
    new Request(input, init).headers.forEach((value, key) => {
      seen[key.toLowerCase()] = value;
    });
    if (seen["mcp-name"] !== undefined || seen["mcp-method"] !== undefined) {
      headers = seen;
    }
    return original(input, init);
  }) as typeof globalThis.fetch;

  try {
    await fn();
    return headers === undefined ? {} : { headers };
  } catch (error) {
    return headers === undefined ? { error } : { headers, error };
  } finally {
    globalThis.fetch = original;
  }
}
