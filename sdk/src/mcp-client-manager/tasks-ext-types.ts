/**
 * PIN: modelcontextprotocol/ext-tasks @ 2c1425d9a288b9b1f489430fe1e00bb392b47e48
 * (`specification/draft/tasks.md`, `schema/draft/schema.ts`). Re-diff against
 * that commit when re-syncing; delete these files for the published
 * `@modelcontextprotocol/ext-tasks` package once it ships.
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
 * The five `DetailedTask` variants (`schema/draft/schema.ts:217-222`, rendered
 * in `schema.json` as an `anyOf` with per-variant `required`). The status is
 * the discriminator and the status payload is NOT optional:
 * `specification/draft/tasks.md:330-336` states each as a MUST.
 *
 * Fields a variant does not carry are declared `?: undefined` rather than
 * omitted so that reading `task.result` / `task.error` / `task.inputRequests`
 * off the bare union still type-checks (narrowing on `status` gives the
 * precise type). Runtime passthrough is unaffected — a server that sends an
 * extra key still has it preserved, because a debugger must show what was
 * actually sent.
 */
export interface WorkingTaskExt extends TaskExt {
  status: "working";
  result?: undefined;
  error?: undefined;
  inputRequests?: undefined;
}

export interface InputRequiredTaskExt extends TaskExt {
  status: "input_required";
  /**
   * Keyed snapshot map re-sent on every poll (dedupe by key; partial
   * responses are allowed).
   */
  inputRequests: InputRequests;
  result?: undefined;
  error?: undefined;
}

export interface CompletedTaskExt extends TaskExt {
  status: "completed";
  /** The original request's result, INLINE (there is no `tasks/result`). */
  result: Record<string, unknown>;
  error?: undefined;
  inputRequests?: undefined;
}

export interface FailedTaskExt extends TaskExt {
  status: "failed";
  /**
   * The JSON-RPC error that caused the failure. `failed` is ONLY for
   * protocol-level faults: a tool result with `isError: true` is a `completed`
   * task (tasks.md:837, :891-892).
   */
  error: TaskExtError;
  result?: undefined;
  inputRequests?: undefined;
}

export interface CancelledTaskExt extends TaskExt {
  status: "cancelled";
  result?: undefined;
  error?: undefined;
  inputRequests?: undefined;
}

/**
 * `tasks/get` / `notifications/tasks` body — the status-discriminated union.
 */
export type DetailedTaskExt =
  | WorkingTaskExt
  | InputRequiredTaskExt
  | CompletedTaskExt
  | FailedTaskExt
  | CancelledTaskExt;

/** Discriminator shared by every 2026-07-28 result. */
export type TaskExtResultType = "complete" | "input_required" | "task";

/**
 * The flat `CreateTaskResult` a server MAY return in place of the requested
 * result. MUST NOT be returned before the task is durably readable via
 * `tasks/get`.
 *
 * `CreateTaskResult = Result & Task` is FLAT (schema.ts:232): it legitimately
 * never carries `result` / `error` / `inputRequests`, so the DetailedTask
 * union does NOT apply to it. `resultType: "task"` stays required — it is the
 * documented discriminator (tasks.md:102, MUST).
 */
export interface CreateTaskExtResult extends TaskExt {
  resultType: "task";
}

/**
 * `tasks/get` result.
 *
 * SPEC CONFLICT (pin 2c1425d9): tasks.md:338 says `resultType` **MUST** be
 * `"complete"` here, but `resultType` appears in `schema.json` nowhere, and
 * every DetailedTask variant is `additionalProperties: false` — so a validator
 * built from the JSON Schema would REJECT the key the prose mandates. We
 * therefore accept the response with OR without it and never require it. Do
 * not "fix" this by making it required until the two agree upstream.
 */
export type GetTaskExtResult = DetailedTaskExt & { resultType?: "complete" };

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
export type TaskExtNotificationParams = DetailedTaskExt & {
  _meta?: Record<string, unknown>;
};
