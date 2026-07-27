/**
 * Wire-boundary guards for `io.modelcontextprotocol/tasks` (SEP-2663)
 * payloads. Every guard validates against the vendored zod mirrors in
 * `tasks-ext-schemas.ts` — untrusted server input is never merely sniffed.
 *
 * The legacy (2025-11-25) guards in `result-guards.ts` are untouched: the two
 * wires are not compatible and must not share a validator.
 */

import {
  createTaskExtResultSchema,
  detailedTaskExtSchema,
  getTaskExtResultSchema,
  taskExtNotificationParamsSchema,
} from "./tasks-ext-schemas.js";
import type {
  CreateTaskExtResult,
  DetailedTaskExt,
  GetTaskExtResult,
  TaskExtNotificationParams,
} from "./tasks-ext-types.js";

/** Thrown when a server sends a task payload that fails validation. */
export class InvalidTaskExtPayloadError extends TypeError {
  readonly issues: string[];
  constructor(context: string, issues: string[]) {
    super(
      `${context} is not a valid io.modelcontextprotocol/tasks payload: ${issues.join("; ")}`
    );
    this.name = "InvalidTaskExtPayloadError";
    this.issues = issues;
  }
}

function issuesOf(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map(
    (issue) =>
      `${issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>"}: ${issue.message}`
  );
}

/**
 * A `tools/call` result is a task creation iff it carries
 * `resultType: "task"`. A non-task result is valid — the server decides — so
 * this is a predicate, not an assertion.
 */
export function isCreateTaskExtResult(
  value: unknown
): value is CreateTaskExtResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { resultType?: unknown }).resultType === "task"
  );
}

export function assertCreateTaskExtResult(
  value: unknown,
  context = "tools/call task result"
): CreateTaskExtResult {
  const parsed = createTaskExtResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidTaskExtPayloadError(context, issuesOf(parsed.error));
  }
  return parsed.data as CreateTaskExtResult;
}

export function assertGetTaskExtResult(
  value: unknown,
  context = "tasks/get result"
): GetTaskExtResult {
  const parsed = getTaskExtResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidTaskExtPayloadError(context, issuesOf(parsed.error));
  }
  return parsed.data as GetTaskExtResult;
}

export function assertDetailedTaskExt(
  value: unknown,
  context = "task"
): DetailedTaskExt {
  const parsed = detailedTaskExtSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidTaskExtPayloadError(context, issuesOf(parsed.error));
  }
  return parsed.data as DetailedTaskExt;
}

export function parseTaskExtNotificationParams(
  value: unknown
): TaskExtNotificationParams | undefined {
  const parsed = taskExtNotificationParamsSchema.safeParse(value);
  return parsed.success
    ? (parsed.data as TaskExtNotificationParams)
    : undefined;
}
