/**
 * Per-task poll scheduling for the Tasks tab, backed by the SDK's shared
 * lifecycle engine.
 *
 * ## What this replaces
 *
 * The tab used to collapse every active task into one interval:
 *
 * ```ts
 * Math.min(...activeTasks.map(t => t.pollInterval))          // the fastest wins
 * userOverride ?? serverSuggestedPollInterval ?? userDefault // a ?? chain
 * ```
 *
 * Both are wrong, in the same direction. The `Math.min` applied the fastest
 * task's floor to every other task, so one task advertising 500ms dragged a
 * task asking for 30s down with it. The `??` chain let a user override
 * *replace* the server's floor rather than be clamped by it, so a user typing
 * 500 into the box polled a 30s-floor server sixty times per interval.
 *
 * The engine's rule is that every term is a `max`, applied **per task**:
 *
 * ```text
 * max(server pollIntervalMs, user minimum, retry backoff, Retry-After)
 * ```
 *
 * The user's setting is a *preferred minimum*, not permission to go faster.
 *
 * ## Batching
 *
 * The hosted path polls in batches, one ephemeral connection per server per
 * tick. A batch polls every member, so it takes the **slowest** member's floor
 * — taking the fastest would breach every other member's. {@link dueTaskIds}
 * only ever returns tasks that are individually due, so a batch built from it
 * is already legal.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  TaskLifecycleEngine,
  isTerminalLifecycleStatus,
  taskLifecycleKey,
  type TaskLifecycleIdentity,
  type TaskLifecycleObservation,
  type LiveTasksWire,
} from "@mcpjam/sdk/browser";
import {
  getRespondedInputKeys,
  getTrackedTaskRestoreStates,
  recordRespondedInputKeys,
  recordTaskObservations,
  taskIdentity,
} from "@/lib/task-tracker";

/**
 * Narrows a persisted status string to a terminal lifecycle status.
 *
 * Only the three PROTOCOL terminal states are restored. MCPJam's own `expired`
 * tombstone is deliberately excluded: it means the server forgot the handle,
 * and a fresh session should be free to confirm that rather than inherit it.
 */
function restoredTerminalStatus(
  status: string | undefined
): "completed" | "failed" | "cancelled" | undefined {
  return status === "completed" || status === "failed" || status === "cancelled"
    ? status
    : undefined;
}

export interface SchedulerTaskState {
  taskId: string;
  status: string;
  /** Server-advertised floor, already normalized to milliseconds by the route. */
  pollIntervalMs?: number;
  ttlMs?: number | null;
  lastUpdatedAt?: string;
}

export interface UseTaskSchedulerArgs {
  serverId: string | undefined;
  wire: LiveTasksWire | "none";
  scope?: string;
  /** The user's preferred minimum, from the tab's poll-interval box. */
  userMinimumIntervalMs: number;
  /**
   * Extra floor applied to every task on this surface. The hosted path passes
   * its connection-cost floor here, because each hosted tick is a full
   * authorize → connect → request → disconnect round trip.
   */
  surfaceFloorMs?: number;
}

export interface TaskScheduler {
  /**
   * Narrows `candidateTaskIds` to the ones actually due now. An unknown handle
   * is treated as due, so a newly created task is polled immediately and the
   * floor applies only from its first observation onward.
   */
  dueTaskIds(candidateTaskIds: readonly string[]): string[];
  /** Folds a poll's results back in, rescheduling each task by its own floor. */
  recordObservations(states: readonly SchedulerTaskState[]): void;
  /** Records a failed read for these ids: backoff, no status change. */
  recordErrors(taskIds: readonly string[]): void;
  /** Stops scheduling a handle (dismissed, cleared, or confirmed expired). */
  forget(taskIds: readonly string[]): void;
  /**
   * Marks input keys answered, AFTER their `tasks/update` was acknowledged.
   * Persists the keys — never the prompt or the response — so a reload does
   * not re-prompt for something the user already answered.
   */
  markInputResponded(taskId: string, keys: readonly string[]): void;
  /** Input keys already acknowledged for this handle, across reloads. */
  respondedInputKeys(taskId: string): string[];
  /**
   * Milliseconds until the next task is due, for arming one timer. Falls back
   * to the user's minimum when nothing is scheduled yet, so the first tick
   * after a page load still happens.
   */
  msUntilNextDue(): number;
  /** The floor a batch of these ids must respect: the SLOWEST member's. */
  batchIntervalMs(taskIds: readonly string[]): number;
}

export function useTaskScheduler({
  serverId,
  wire,
  scope,
  userMinimumIntervalMs,
  surfaceFloorMs = 0,
}: UseTaskSchedulerArgs): TaskScheduler {
  // The engine is keyed to the connection it holds records for. The hook
  // instance survives a server or wire switch, and stale records from the
  // previous connection would keep answering `due()` — pinning
  // `msUntilNextDue()` at zero forever, because nothing on the NEW connection
  // ever observes or forgets them, so every re-arm would collapse to the floor.
  const identityKey = `${scope ?? ""}\u0000${serverId ?? ""}\u0000${wire}`;
  const engineRef = useRef<TaskLifecycleEngine | undefined>(undefined);
  const engineKeyRef = useRef<string | undefined>(undefined);
  if (!engineRef.current || engineKeyRef.current !== identityKey) {
    engineRef.current = new TaskLifecycleEngine({
      userMinimumIntervalMs: Math.max(userMinimumIntervalMs, surfaceFloorMs),
    });
    engineKeyRef.current = identityKey;
  }
  const engine = engineRef.current;

  // A change to either term must take effect on the ALREADY-SCHEDULED tasks,
  // not only on the next ones — otherwise raising the interval leaves every
  // in-flight task polling at the old rate until it happens to complete.
  //
  // In an effect, not during render: the engine is a ref-held mutable object,
  // and writing to it while rendering is a side effect in the render phase.
  // The write is idempotent, so this is a purity fix rather than a bug fix —
  // but the rule holds regardless, and an effect is where a commit-time
  // reconciliation of external state belongs.
  const effectiveMinimum = Math.max(userMinimumIntervalMs, surfaceFloorMs);
  useEffect(() => {
    if (engine.getUserMinimumIntervalMs() !== effectiveMinimum) {
      engine.setUserMinimumIntervalMs(effectiveMinimum);
    }
  }, [engine, effectiveMinimum]);

  const identityFor = useCallback(
    (taskId: string): TaskLifecycleIdentity | undefined => {
      if (!serverId || wire === "none") return undefined;
      return { serverId, wire, taskId, ...(scope ? { scope } : {}) };
    },
    [serverId, wire, scope]
  );

  return useMemo<TaskScheduler>(
    () => ({
      dueTaskIds(candidateTaskIds) {
        // Keyed on the COMPOSITE identity, not the bare task id: the engine
        // may hold the same id under a different server, wire or scope, and
        // matching on the id alone would let one of them satisfy another's
        // due check.
        const due = new Set(engine.due().map((record) => record.key));
        const now = Date.now();
        // ONE store read for every handle this tick has never seen, rather
        // than two per handle. After a reload EVERY tracked handle is unseen,
        // so the per-handle form ran 2N full parses of the whole store in a
        // single tick on the main thread — the cost the batched write path
        // already avoids on the other side.
        const unseen = candidateTaskIds
          .map((taskId) => identityFor(taskId))
          .filter(
            (identity): identity is TaskLifecycleIdentity =>
              !!identity && !engine.get(identity)
          );
        const restoreStates = getTrackedTaskRestoreStates(unseen);

        return candidateTaskIds.filter((taskId) => {
          const identity = identityFor(taskId);
          if (!identity) return false;
          if (!engine.get(identity)) {
            // First sighting this session — which, after a reload, means EVERY
            // tracked handle. Seed the engine from the persisted schedule
            // instead of registering fresh: registering fresh makes every
            // restored handle due immediately, so a series of reloads would
            // poll a server far faster than it asked to be polled, and the
            // durable `nextPollAt` would never do anything.
            const persisted = restoreStates.get(taskIdentity(identity));
            engine.register(identity, {
              restored: true,
              pollIntervalMs: persisted?.pollIntervalMs,
              ttlMs: persisted?.ttlMs,
              // A handle we last saw finished must come back finished. Without
              // this it restores as `unknown`, reads as non-terminal, and gets
              // polled again — re-reading a task whose result we already have.
              status: restoredTerminalStatus(persisted?.status),
              nextPollAt: persisted?.nextPollAt,
              lastObservedAt: persisted?.lastObservedAt,
              // Restored so a reload does not re-prompt for an input the user
              // already answered and the server already acknowledged.
              respondedInputKeys: persisted?.respondedInputKeys,
            });
            const restored = engine.get(identity);
            if (restored && isTerminalLifecycleStatus(restored.status)) {
              return false;
            }
            if (persisted?.nextPollAt !== undefined) {
              // A handle whose stored floor has not elapsed is NOT due, even
              // though we have never read it in this session.
              return persisted.nextPollAt <= now;
            }
            // No persisted schedule ⇒ genuinely new. The floor governs how
            // often to RE-read, not a delay before the first read.
            return true;
          }
          return due.has(taskLifecycleKey(identity));
        });
      },

      recordObservations(states) {
        const persist: Parameters<typeof recordTaskObservations>[0][number][] =
          [];
        for (const state of states) {
          const identity = identityFor(state.taskId);
          if (!identity) continue;
          const observation = {
            status: state.status as TaskLifecycleObservation["status"],
            pollIntervalMs: state.pollIntervalMs,
            ttlMs: state.ttlMs,
            lastUpdatedAt: state.lastUpdatedAt,
          } satisfies TaskLifecycleObservation;
          const record = engine.observe(identity, observation);
          persist.push({
            identity,
            observation: {
              status: record.status,
              lastUpdatedAt: record.lastUpdatedAt,
              ttlMs: record.ttlMs,
              pollIntervalMs: record.pollIntervalMs,
              nextPollAt: Number.isFinite(record.nextPollAt)
                ? record.nextPollAt
                : undefined,
              lastObservedAt: record.lastObservedAt,
            },
          });
        }
        // ONE load + save for the whole tick. Mirroring the scheduling state
        // into durable storage is what lets a reload resume at the right time
        // rather than restarting every task at its floor.
        recordTaskObservations(persist);
      },

      recordErrors(taskIds) {
        const persist: Parameters<typeof recordTaskObservations>[0][number][] =
          [];
        for (const taskId of taskIds) {
          const identity = identityFor(taskId);
          if (!identity) continue;
          const record = engine.observeError(identity);
          // The backoff has to be DURABLE. Persisting only successful
          // observations left the tracker holding the already-elapsed
          // `nextPollAt` from the last good read, so a reload during backoff
          // restored the handle as immediately due and retried at once —
          // repeated reloads would walk straight through the backoff.
          persist.push({
            identity,
            observation: {
              nextPollAt: Number.isFinite(record.nextPollAt)
                ? record.nextPollAt
                : undefined,
            },
          });
        }
        recordTaskObservations(persist);
      },

      markInputResponded(taskId, keys) {
        const identity = identityFor(taskId);
        if (!identity || keys.length === 0) return;
        engine.markInputKeysResponded(identity, keys);
        recordRespondedInputKeys(identity, keys);
      },

      respondedInputKeys(taskId) {
        const identity = identityFor(taskId);
        if (!identity) return [];
        // Union of this session's engine state and what survived a reload.
        const persisted = getRespondedInputKeys(identity);
        const record = engine.get(identity);
        return [
          ...new Set([...persisted, ...(record?.respondedInputKeys ?? [])]),
        ];
      },

      forget(taskIds) {
        for (const taskId of taskIds) {
          const identity = identityFor(taskId);
          if (identity) engine.forget(identity);
        }
      },

      msUntilNextDue() {
        return engine.msUntilNextDue() ?? effectiveMinimum;
      },

      batchIntervalMs(taskIds) {
        const records = taskIds
          .map((taskId) => identityFor(taskId))
          .filter((identity): identity is TaskLifecycleIdentity => !!identity)
          .map((identity) => engine.get(identity))
          .filter((record): record is NonNullable<typeof record> => !!record);
        return engine.batchIntervalMs(records);
      },
    }),
    [engine, identityFor, effectiveMinimum]
  );
}
