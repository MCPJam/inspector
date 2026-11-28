/**
 * The launch engine's vocabulary: the backend's generic run-group launch
 * record, and what an adopter (an adapter) supplies to launch its items.
 *
 * A run group is one launch of many runs: for swarms, a swarm run and its
 * goals. The engine knows nothing about what an item launches; `P` is the
 * adopter's own item parameters, stored on the record as given.
 */
import type { ErrorCode } from "../../routes/web/errors.js";
import type {
  LaunchError,
  LaunchItemStatus,
  LaunchState,
} from "../../../shared/run-group-launch.js";

/** What a launch record launches. Each kind has its own adapter. */
export type LaunchKind = "swarm";

export interface RunGroupLaunchItem<P> {
  /** Unique within the launch (a swarm's goal id). */
  itemKey: string;
  /** The item's run idempotency key, derived by the backend. */
  launchKey: string;
  status: LaunchItemStatus;
  runId?: string;
  deduped?: boolean;
  error?: LaunchError;
  reason?: string;
  params: P;
}

export interface RunGroupLaunchRecord<P> {
  kind: LaunchKind;
  runGroupId: string;
  swarmId?: string | null;
  sourceRunGroupId?: string | null;
  state: LaunchState;
  createdAt: number;
  finishedAt?: number;
  stopReason?: LaunchError;
  retryAfterAt?: number;
  generation?: number;
  items: RunGroupLaunchItem<P>[];
}

/** An item a new launch begins with, in launch order. */
export type PlannedItem<P> = { itemKey: string; params: P };

/** A new launch, as the adopter planned it. */
export interface PlannedRunGroup<P> {
  items: PlannedItem<P>[];
  swarmId?: string;
  sourceRunGroupId?: string;
}

/**
 * What a launch does with one item's failed start:
 *   `item_failed` fails that item, and the launch goes on;
 *   `{ wait }` waits that long and tries the item again, up to the engine's cap;
 *   `retry` tries again with backoff, a few times, then stops the launch;
 *   `{ stop }` stops the launch, with that reason, and `retryAfterMs` when the
 *   refusal said when it lifts.
 */
export type ItemFailure =
  | "item_failed"
  | { wait: number }
  | "retry"
  | { stop: LaunchError; retryAfterMs?: number };

export interface LaunchItemContext {
  /** The request's bearer before the reply; a fresh run bearer after it. */
  bearer: string;
  phase: "request" | "background";
  runGroupId: string;
}

/** What an adopter supplies to launch its items. */
export interface RunGroupLaunchAdapter<P> {
  kind: LaunchKind;
  /** Items started at once in the background, or a rule over the record's items. */
  concurrency: number | ((items: readonly RunGroupLaunchItem<P>[]) => number);
  launchItem(
    item: RunGroupLaunchItem<P>,
    context: LaunchItemContext,
  ): Promise<{ runId: string; deduped?: boolean }>;
  classifyError(error: unknown): ItemFailure;
  /** What the record keeps about a failed start: words fit to show. */
  describeError(error: unknown): LaunchError;
}

export interface RunGroupLaunchDeps {
  /** The request's own bearer: every backend call before the reply. */
  bearerToken: string;
  /** A long-lived bearer, minted per call: every backend call after the reply. */
  getRunBearer: () => Promise<string>;
}

/** A refusal for the calling route to render in its own envelope. */
export interface RunGroupRefusal<P> {
  status: number;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
  /** The record, when the refusal came after it was written. */
  record?: RunGroupLaunchRecord<P>;
  /** Wire headers the refusal owns: `Retry-After` on a 429. */
  headers?: Record<string, string>;
}

/** A launch under way or answered from its record (202), or a refusal. */
export type RunGroupLaunchOutcome<P> =
  { status: 202; record: RunGroupLaunchRecord<P> } | RunGroupRefusal<P>;
