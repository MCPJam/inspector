/**
 * PIN: the ext-tasks repo (spec-only, private, unpublished) was NOT available
 * in the authoring environment, so no upstream commit SHA can be recorded here.
 * These shapes were hand-written from the SEP-2663 draft as summarized in the
 * restoration plan (`specification/draft/tasks.md`, `schema/draft/schema.ts`).
 * Record the SHA — or delete these files for the published package — as soon as
 * either is reachable.
 */
/**
 * Vendored types for the `io.modelcontextprotocol/tasks` extension
 * (SEP-2663).
 *
 * VENDORED-FROM-SEP-2663-DRAFT — hand-written from the extension's
 * `schema/draft/schema.ts` shapes. The extension repo is spec-only and
 * unpublished; when `@modelcontextprotocol/ext-tasks` ships, delete this file
 * and import the package types (the ext-apps precedent). Type imports are
 * rewritten to `@modelcontextprotocol/client` — the same names `mrtr-driver.ts`
 * already imports — so the repo's `check:mcp-v1-runtime-imports` guard stays
 * green and there is exactly one source of truth for `InputRequests` /
 * `InputResponses`.
 *
 * Wire-level differences from the 2025-11-25 in-core utility (do not mix):
 *   - the server decides; there is no `params.task` opt-in;
 *   - `ttlMs` / `pollIntervalMs` (numbers, `ttlMs` nullable), not
 *     `ttl` / `pollInterval`;
 *   - `tasks/get` on a completed task carries the `result` INLINE — there is
 *     no `tasks/result`, and no `tasks/list`;
 *   - results are discriminated by a `resultType` tri-state
 *     (`"complete" | "input_required" | "task"`).
 */

import type {
  InputRequests,
  InputResponses,
} from "@modelcontextprotocol/client";

export type { InputRequests, InputResponses };

/** Task lifecycle states (SEP-2663). */
export type TaskExtStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

/** Terminal states — a task in one of these will not change again. */
export const TERMINAL_TASK_EXT_STATUSES: readonly TaskExtStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

/** JSON-RPC error object carried by a `failed` task. */
export interface TaskExtError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * The task handle. `ttlMs` is `null` for a task with no expiry (distinct from
 * an absent field); `pollIntervalMs` is the server's requested poll floor.
 */
export interface TaskExt {
  taskId: string;
  status: TaskExtStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  _meta?: Record<string, unknown>;
}

/**
 * `tasks/get` response. Beyond the task handle it carries, per status:
 *   - `completed` → `result` INLINE (the original request's result);
 *   - `failed` → `error` (a JSON-RPC error object);
 *   - `input_required` → `inputRequests`, a keyed snapshot map re-sent on
 *     every poll (dedupe by key; partial responses are allowed).
 */
export interface DetailedTaskExt extends TaskExt {
  result?: unknown;
  error?: TaskExtError;
  inputRequests?: InputRequests;
}

/** Discriminator shared by every 2026-07-28 result. */
export type TaskExtResultType = "complete" | "input_required" | "task";

/**
 * The flat `CreateTaskResult` a server MAY return in place of the requested
 * result. MUST NOT be returned before the task is durably readable via
 * `tasks/get`.
 */
export interface CreateTaskExtResult extends TaskExt {
  resultType: "task";
}

/** `tasks/get` result. */
export interface GetTaskExtResult extends DetailedTaskExt {
  resultType?: "complete";
}

/**
 * `tasks/update` result — per SEP-2663 `UpdateTaskResult = Result`: an EMPTY,
 * eventually-consistent acknowledgement. It carries no task state, so callers
 * must re-poll `tasks/get` for the post-update status.
 */
export type UpdateTaskExtResult = Record<string, unknown>;

/**
 * `tasks/cancel` result — an EMPTY acknowledgement. Cancellation is
 * cooperative: the task may keep working, complete normally, or be deleted.
 * Never render this as the task's new state; re-poll instead.
 */
export type CancelTaskExtResult = Record<string, unknown>;

/**
 * `notifications/tasks` body (optional; delivered via `subscriptions/listen`).
 * SEP-2663 carries a full `DetailedTask`, so the extra task fields are part of
 * the payload rather than an unrelated envelope.
 */
export interface TaskExtNotificationParams extends DetailedTaskExt {
  _meta?: Record<string, unknown>;
}
