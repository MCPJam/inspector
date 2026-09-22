/**
 * Hosted task polling constants, shared by the client poller and the hosted
 * routes' batch schema so the two can never drift.
 */

/**
 * Floor for hosted poll ticks. Every hosted poll is a full
 * authorize → connect → request → disconnect round trip, so a user-configured
 * interval below this would multiply connection cost for no added fidelity.
 * The effective interval is `max(userInterval, HOSTED_TASK_POLL_FLOOR_MS)`,
 * further widened by a server-advertised `pollIntervalMs`.
 */
export const HOSTED_TASK_POLL_FLOOR_MS = 2000;

/**
 * Maximum task IDs per `/get-batch` call — one connection per server per tick
 * is the main hosted cost control. The route schema enforces the same number
 * (it imports this constant, aliased as `HOSTED_TASK_BATCH_MAX`).
 */
export const HOSTED_TASK_BATCH_LIMIT = 50;

/** Route-side alias for {@link HOSTED_TASK_BATCH_LIMIT}. */
export const HOSTED_TASK_BATCH_MAX = HOSTED_TASK_BATCH_LIMIT;

/**
 * Server-side task age at which the client stops tracking a handle even if it
 * was never resolved: task IDs are bearer-ish and unbounded growth in
 * localStorage helps nobody.
 */
export const TRACKED_TASK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Statuses the hosted task registry stores, hand-mirrored from the backend's
 * `STATUSES` set (mcpjam-backend `convex/hostedTasksRoutes.ts`; two-repo
 * layout, no cross-repo imports). `expired` is registry-only: it records that
 * a live read answered -32602 for the handle, which neither wire has a status
 * for.
 */
export type RegistryTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

/**
 * One row of the hosted task recovery index, hand-mirrored from the backend's
 * `listHostedTasks` returns validator (mcpjam-backend `convex/hostedTasks.ts`).
 * All timestamps are epoch milliseconds. This is an INDEX entry, never the
 * task itself: `lastKnownStatus` is only the last status something reported,
 * and the live `tasks/get` read stays the source of truth.
 */
export interface RegistryTaskEntry {
  wire: "legacy" | "extension";
  taskId: string;
  lastKnownStatus: RegistryTaskStatus;
  createdAt: number;
  updatedAt: number;
  lastObservedAt: number;
  /** Present once the row went terminal; the backend prunes 24h after it. */
  terminalAt?: number;
}

/** Terminal per the registry's own taxonomy (includes its `expired`). */
export function isTerminalRegistryStatus(status: RegistryTaskStatus): boolean {
  return status !== "working" && status !== "input_required";
}

const REGISTRY_TASK_STATUSES = new Set<RegistryTaskStatus>([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

/**
 * Normalizes a live wire status onto the registry taxonomy: the extension
 * wire hyphenates (`input-required`) where the registry stores underscores.
 * Unrecognized values return `null` and must be DROPPED, not defaulted —
 * the backend 400s unknown statuses, and defaulting to `working` would keep
 * a vanished handle's row alive.
 */
export function toRegistryTaskStatus(value: unknown): RegistryTaskStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/-/g, "_") as RegistryTaskStatus;
  return REGISTRY_TASK_STATUSES.has(normalized) ? normalized : null;
}

export function hostedPollIntervalMs(
  userIntervalMs: number,
  serverPollIntervalMs?: number,
): number {
  return Math.max(
    userIntervalMs,
    HOSTED_TASK_POLL_FLOOR_MS,
    serverPollIntervalMs ?? 0,
  );
}
