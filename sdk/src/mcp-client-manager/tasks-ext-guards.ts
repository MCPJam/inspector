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
  taskExtAckSchema,
  taskExtNotificationParamsSchema,
} from "./tasks-ext-schemas.js";
import type {
  CancelTaskExtResult,
  CreateTaskExtResult,
  DetailedTaskExt,
  GetTaskExtResult,
  TaskExtNotificationParams,
} from "./tasks-ext-types.js";

/** Max issues / characters kept in the human-facing violation summary. */
const MAX_SUMMARY_ISSUES = 5;
const MAX_SUMMARY_LENGTH = 500;
const MAX_SEGMENT_LENGTH = 64;

/**
 * Server-controlled text (an `inputRequests` key becomes an issue path
 * segment) is truncated and stripped of control characters before it reaches a
 * message or a log line.
 */
function safeText(value: string, maxLength = MAX_SEGMENT_LENGTH): string {
  // Control characters would corrupt a terminal / log line.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  return cleaned.length > maxLength
    ? `${cleaned.slice(0, maxLength)}…`
    : cleaned;
}

/**
 * Thrown when a server sends a task payload that fails validation.
 *
 * This is an INVALID-SERVER-RESPONSE condition, distinct from "this connection
 * does not speak the tasks extension" (`MCPTasksWireError`). Routes must not
 * collapse the two: an unsupported wire is permanent, whereas a bad payload is
 * a server bug worth surfacing with its method and violations.
 */
export class InvalidTaskExtPayloadError extends TypeError {
  readonly issues: string[];
  /** The extension method whose response failed, e.g. `"tasks/get"`. */
  readonly method?: string;
  /** Always the extension wire — the legacy guards live in `result-guards.ts`. */
  readonly wire: "extension" = "extension";
  /** Truncated, control-character-free violation summary, safe to log. */
  readonly summary: string;

  constructor(
    context: string,
    issues: string[],
    options?: { method?: string }
  ) {
    const summary = safeText(
      issues.slice(0, MAX_SUMMARY_ISSUES).join("; "),
      MAX_SUMMARY_LENGTH
    );
    super(
      `${context} is not a valid io.modelcontextprotocol/tasks payload: ${summary}`
    );
    this.name = "InvalidTaskExtPayloadError";
    this.issues = issues;
    this.method = options?.method;
    this.summary = summary;
  }
}

/** Type guard for {@link InvalidTaskExtPayloadError}. */
export function isInvalidTaskExtPayloadError(
  error: unknown
): error is InvalidTaskExtPayloadError {
  return error instanceof InvalidTaskExtPayloadError;
}

function issuesOf(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map(
    (issue) =>
      `${issue.path.length > 0 ? issue.path.map((segment) => safeText(String(segment))).join(".") : "<root>"}: ${safeText(issue.message)}`
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
  context = "tools/call task result",
  method = "tools/call"
): CreateTaskExtResult {
  const parsed = createTaskExtResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidTaskExtPayloadError(context, issuesOf(parsed.error), {
      method,
    });
  }
  return parsed.data as CreateTaskExtResult;
}

export function assertGetTaskExtResult(
  value: unknown,
  context = "tasks/get result",
  method = "tasks/get"
): GetTaskExtResult {
  const parsed = getTaskExtResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidTaskExtPayloadError(context, issuesOf(parsed.error), {
      method,
    });
  }
  return parsed.data as GetTaskExtResult;
}

export function assertDetailedTaskExt(
  value: unknown,
  context = "task",
  method?: string
): DetailedTaskExt {
  const parsed = detailedTaskExtSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidTaskExtPayloadError(context, issuesOf(parsed.error), {
      method,
    });
  }
  return parsed.data as DetailedTaskExt;
}

/**
 * `tasks/update` / `tasks/cancel` acknowledgement. The ack is a bare `Result`
 * and carries NO task state — it is validated as an object only, and callers
 * must re-poll `tasks/get` for the post-operation status. Any non-object,
 * INCLUDING `undefined`, is a wire violation.
 *
 * `undefined` used to be normalized to `{}` on the theory that a transport may
 * surface an empty result as nothing. It cannot: beta.4's 2026 codec rejects a
 * non-object `result` outright (`decodeResult`, client `src-*.mjs:3828-3835`),
 * a well-formed empty ack arrives as `{"resultType":"complete"}` and is lifted
 * to `{}` (`src-*.mjs:3878-3884`), and the complete branch only ever resolves
 * what the caller's result schema accepted (`src-*.mjs:6045-6049`) — the
 * schema these calls pass is `z.looseObject({})`, which rejects `undefined`.
 * So `undefined` here means a malformed or missing result and must not be
 * laundered into a valid empty ack.
 */
export function assertTaskExtAck(
  value: unknown,
  context: string,
  method?: string
): CancelTaskExtResult {
  const parsed = taskExtAckSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidTaskExtPayloadError(context, issuesOf(parsed.error), {
      method,
    });
  }
  return parsed.data as CancelTaskExtResult;
}

export function parseTaskExtNotificationParams(
  value: unknown
): TaskExtNotificationParams | undefined {
  const parsed = taskExtNotificationParamsSchema.safeParse(value);
  return parsed.success
    ? (parsed.data as TaskExtNotificationParams)
    : undefined;
}

/**
 * Strict form of {@link parseTaskExtNotificationParams}.
 *
 * A `notifications/tasks` payload carries a full `DetailedTask` and is
 * validated **identically to `tasks/get`** — the delivery channel changes
 * nothing about how much a payload is trusted. Use this wherever a rejected
 * notification should be diagnosable; use the lenient parser only where the
 * caller genuinely wants to drop unparseable traffic and keep polling.
 */
export function assertTaskExtNotificationParams(
  value: unknown,
  context = "notifications/tasks params",
  method = "notifications/tasks"
): TaskExtNotificationParams {
  const parsed = taskExtNotificationParamsSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidTaskExtPayloadError(context, issuesOf(parsed.error), {
      method,
    });
  }
  return parsed.data as TaskExtNotificationParams;
}
