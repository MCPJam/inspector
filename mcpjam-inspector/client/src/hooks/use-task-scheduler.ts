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
  type TaskLifecycleIdentity,
  type TaskLifecycleObservation,
  type LiveTasksWire,
} from "@mcpjam/sdk/browser";
import { recordTaskObservation } from "@/lib/task-tracker";

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
    [serverId, wire, scope],
  );

  return useMemo<TaskScheduler>(
    () => ({
      dueTaskIds(candidateTaskIds) {
        const due = new Set(
          engine.due().map((record) => record.identity.taskId),
        );
        return candidateTaskIds.filter((taskId) => {
          const identity = identityFor(taskId);
          if (!identity) return false;
          // Never observed ⇒ due now. The floor is a statement about how often
          // to RE-read, not a delay before the first read.
          if (!engine.get(identity)) {
            engine.register(identity, { restored: true });
            return true;
          }
          return due.has(taskId);
        });
      },

      recordObservations(states) {
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
          // Mirror the scheduling state into durable storage so a reload
          // resumes at the right time rather than restarting every task.
          recordTaskObservation(identity, {
            status: record.status,
            lastUpdatedAt: record.lastUpdatedAt,
            ttlMs: record.ttlMs,
            pollIntervalMs: record.pollIntervalMs,
            nextPollAt: Number.isFinite(record.nextPollAt)
              ? record.nextPollAt
              : undefined,
            lastObservedAt: record.lastObservedAt,
          });
        }
      },

      recordErrors(taskIds) {
        for (const taskId of taskIds) {
          const identity = identityFor(taskId);
          if (identity) engine.observeError(identity);
        }
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
    [engine, identityFor, effectiveMinimum],
  );
}
