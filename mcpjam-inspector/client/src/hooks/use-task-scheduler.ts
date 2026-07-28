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

import { useCallback, useMemo, useRef } from "react";
import {
  TaskLifecycleEngine,
  taskLifecycleKey,
  type TaskLifecycleIdentity,
  type TaskLifecycleObservation,
  type LiveTasksWire,
} from "@mcpjam/sdk/browser";
import {
  getRespondedInputKeys,
  getTrackedTaskSchedule,
  recordRespondedInputKeys,
  recordTaskObservations,
} from "@/lib/task-tracker";

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
  const engineRef = useRef<TaskLifecycleEngine | undefined>(undefined);
  if (!engineRef.current) {
    engineRef.current = new TaskLifecycleEngine({
      userMinimumIntervalMs: Math.max(userMinimumIntervalMs, surfaceFloorMs),
    });
  }
  const engine = engineRef.current;

  // A change to either term must take effect on the ALREADY-SCHEDULED tasks,
  // not only on the next ones — otherwise raising the interval leaves every
  // in-flight task polling at the old rate until it happens to complete.
  const effectiveMinimum = Math.max(userMinimumIntervalMs, surfaceFloorMs);
  if (engine.getUserMinimumIntervalMs() !== effectiveMinimum) {
    engine.setUserMinimumIntervalMs(effectiveMinimum);
  }

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
            const persisted = getTrackedTaskSchedule(identity);
            engine.register(identity, {
              restored: true,
              pollIntervalMs: persisted?.pollIntervalMs,
              ttlMs: persisted?.ttlMs,
              // Restored so a reload does not re-prompt for an input the user
              // already answered and the server already acknowledged.
              respondedInputKeys: getRespondedInputKeys(identity),
            });
            if (persisted?.nextPollAt !== undefined) {
              const record = engine.get(identity);
              if (record) {
                record.nextPollAt = persisted.nextPollAt;
                record.lastObservedAt = persisted.lastObservedAt;
              }
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
        for (const taskId of taskIds) {
          const identity = identityFor(taskId);
          if (identity) engine.observeError(identity);
        }
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
