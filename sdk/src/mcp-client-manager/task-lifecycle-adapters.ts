/**
 * Wire → lifecycle normalizers.
 *
 * The lifecycle engine is deliberately wire-blind: it schedules and remembers,
 * and it must not grow a per-wire branch. These adapters are the only place
 * that knows the difference between a 2025-11-25 in-core task and a SEP-2663
 * extension task, and each keeps its own validator — the two wires are not
 * compatible and must never share one.
 *
 * What is preserved and what is not:
 *
 *  - the raw payload is carried through verbatim, because a debugger has to be
 *    able to show what the server actually sent;
 *  - `ttlMs` distinguishes absent (leave the previous value) from `null` (the
 *    server says: no expiry);
 *  - a tool result with `isError: true` is a **completed** task. Only a
 *    JSON-RPC error makes a task `failed` (`tasks.md:837`, `:891-892`). Getting
 *    this backwards would report a tool's own error as a protocol fault.
 */

import type {
  DetailedTaskExt,
  GetTaskExtResult,
  TaskExtNotificationParams,
} from "./tasks-ext-types.js";
import type { TaskLifecycleObservation } from "./task-lifecycle.js";
import type { MCPTask } from "./types.js";

/**
 * Extension `tasks/get` result or `notifications/tasks` params → observation.
 *
 * Both carry the same `DetailedTask`, so they normalize identically; the caller
 * decides which validator produced the input and tags the observation source.
 */
export function extensionTaskToObservation(
  task: DetailedTaskExt | GetTaskExtResult | TaskExtNotificationParams
): TaskLifecycleObservation {
  const detailed = task as DetailedTaskExt;
  return {
    status: detailed.status,
    statusMessage: detailed.statusMessage,
    createdAt: detailed.createdAt,
    lastUpdatedAt: detailed.lastUpdatedAt,
    // `ttlMs` is required on the wire and may be `null`; passing it through
    // unconditionally is what lets `null` overwrite an earlier number.
    ttlMs: detailed.ttlMs,
    pollIntervalMs: detailed.pollIntervalMs,
    inputRequests:
      detailed.status === "input_required" ? detailed.inputRequests : undefined,
    result: detailed.status === "completed" ? detailed.result : undefined,
    error: detailed.status === "failed" ? detailed.error : undefined,
    raw: task,
  };
}

/**
 * Legacy 2025-11-25 statuses. The in-core utility used the same five names, so
 * the normalized status needs no remapping — only the surrounding fields do.
 */
const LEGACY_STATUSES = new Set([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Legacy `tasks/get` result → observation.
 *
 * The legacy wire names its timing fields `ttl` / `pollInterval` (not `ttlMs` /
 * `pollIntervalMs`) and has no inline result — the result lives behind a
 * separate `tasks/result` call. Both differences are absorbed here so no
 * surface has to branch on the wire.
 *
 * An unrecognized status normalizes to `working` rather than being dropped: a
 * handle we cannot classify is still a handle we must keep polling, and
 * inventing a terminal state would strand it.
 *
 * There is deliberately no `inputRequests` here, and none is missing: the
 * 2025-11-25 `Task` shape carries no keyed request map at all
 * (`taskId`, `status`, `ttl`, `createdAt`, `lastUpdatedAt`, `pollInterval`,
 * `statusMessage` — nothing else). On that wire an `input_required` task's
 * request arrives out of band, as an elicitation stamped with `relatedTaskId`,
 * and is answered through the elicitation channel rather than `tasks/update` —
 * which the legacy wire does not have. `driveTaskToTerminal` recognizes the
 * resulting "input_required with an empty keyed snapshot" and reports
 * `input-required` rather than re-polling an unchanging state.
 */
export function legacyTaskToObservation(
  task: MCPTask & Record<string, unknown>
): TaskLifecycleObservation {
  const rawStatus = String(task.status ?? "");
  const status = LEGACY_STATUSES.has(rawStatus)
    ? (rawStatus as TaskLifecycleObservation["status"])
    : "working";
  const ttl = task.ttl;
  const pollInterval = task.pollInterval;
  return {
    status,
    statusMessage:
      typeof task.statusMessage === "string" ? task.statusMessage : undefined,
    createdAt: typeof task.createdAt === "string" ? task.createdAt : undefined,
    lastUpdatedAt:
      typeof task.lastUpdatedAt === "string" ? task.lastUpdatedAt : undefined,
    ttlMs: typeof ttl === "number" ? ttl : ttl === null ? null : undefined,
    pollIntervalMs: typeof pollInterval === "number" ? pollInterval : undefined,
    raw: task,
  };
}

/**
 * `-32602` is how a server reports a task id it does not know
 * (`tasks.md:793-795`).
 *
 * The requirement level differs by method and the difference is load-bearing:
 * `MUST` for `tasks/get`, `SHOULD` for `tasks/update` and `tasks/cancel`. So
 * only a `tasks/get` `-32602` is proof; from update or cancel it is a hint that
 * has to be confirmed by a `tasks/get` before a handle is retired. Callers get
 * the raw predicate here and apply that rule themselves — see
 * `TaskLifecycleEngine.markExpired`.
 */
export const UNKNOWN_TASK_ERROR_CODE = -32602;

/** The extension's "this operation requires the tasks declaration" code. */
export const TASKS_DECLARATION_REQUIRED_ERROR_CODE = -32003;

function errorCodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "number") return direct;
  const nested = (error as { error?: { code?: unknown } }).error?.code;
  return typeof nested === "number" ? nested : undefined;
}

export function isUnknownTaskError(error: unknown): boolean {
  return errorCodeOf(error) === UNKNOWN_TASK_ERROR_CODE;
}

export function isTasksDeclarationRequiredError(error: unknown): boolean {
  return errorCodeOf(error) === TASKS_DECLARATION_REQUIRED_ERROR_CODE;
}

/**
 * Milliseconds from a `Retry-After` header value, which is either a delta in
 * seconds or an HTTP date. `undefined` for anything else — a malformed hint
 * must not become a zero-length backoff.
 */
export function parseRetryAfterMs(
  value: string | number | null | undefined,
  now: number = Date.now()
): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value * 1000 : undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}
