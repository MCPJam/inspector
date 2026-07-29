/**
 * `useTaskScheduler` — the Tasks tab's per-task poll scheduling.
 *
 * The regression these lock down: the tab used to poll every active task at
 * `Math.min(...)` of their advertised intervals, with a user override that
 * *replaced* the server's floor via a `??` chain. Both let MCPJam poll a
 * server far faster than it asked to be polled.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTaskScheduler } from "../use-task-scheduler";
import {
  getTrackedTasks,
  recordTaskObservation,
  setTrackedTaskScope,
  trackTask,
} from "@/lib/task-tracker";

const NOW = new Date().toISOString();

function scheduler(userMinimumIntervalMs = 1_000, surfaceFloorMs = 0) {
  return renderHook(() =>
    useTaskScheduler({
      serverId: "s1",
      wire: "extension",
      userMinimumIntervalMs,
      surfaceFloorMs,
    })
  );
}

describe("useTaskScheduler", () => {
  beforeEach(() => {
    localStorage.clear();
    setTrackedTaskScope(undefined);
  });

  it("treats a never-observed handle as due immediately", () => {
    const { result } = scheduler();
    expect(result.current.dueTaskIds(["t1"])).toEqual(["t1"]);
  });

  it("does not re-poll a handle before its own floor elapses", () => {
    const { result } = scheduler();
    result.current.dueTaskIds(["t1"]);
    act(() => {
      result.current.recordObservations([
        { taskId: "t1", status: "working", pollIntervalMs: 60_000 },
      ]);
    });
    expect(result.current.dueTaskIds(["t1"])).toEqual([]);
  });

  it("does not drag a slow task down to a fast task's floor", () => {
    vi.useFakeTimers();
    try {
      const { result } = scheduler();
      result.current.dueTaskIds(["fast", "slow"]);
      act(() => {
        result.current.recordObservations([
          { taskId: "fast", status: "working", pollIntervalMs: 2_000 },
          { taskId: "slow", status: "working", pollIntervalMs: 60_000 },
        ]);
      });

      // Immediately after a read, neither is due.
      expect(result.current.dueTaskIds(["fast", "slow"])).toEqual([]);

      // Past the fast task's floor, only the fast task may be read. The old
      // shared-`Math.min` scheduler polled both here.
      vi.advanceTimersByTime(2_000);
      expect(result.current.dueTaskIds(["fast", "slow"])).toEqual(["fast"]);
      // `dueTaskIds` CLAIMS what it hands back, so a caller that never folds
      // the read back has to say so — otherwise the handle stays claimed and
      // the next tick correctly refuses to re-issue it.
      act(() => {
        result.current.release(["fast"]);
      });

      // The slow task comes due only at its own floor.
      vi.advanceTimersByTime(58_000);
      expect(result.current.dueTaskIds(["fast", "slow"]).sort()).toEqual([
        "fast",
        "slow",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("claims what it hands back, so overlapping refreshes cannot duplicate a read", () => {
    const { result } = scheduler();
    // The tab's auto-refresh can interleave with one triggered by an input
    // submission, a cancellation, or a rapid manual click. Without a claim both
    // select the same due handle and issue duplicate `tasks/get` calls inside
    // one advertised floor — where an out-of-order reply overwrites newer state
    // with older.
    expect(result.current.dueTaskIds(["t1"])).toEqual(["t1"]);
    expect(result.current.dueTaskIds(["t1"])).toEqual([]);

    // Folding the read back releases it — the handle is then withheld by its
    // FLOOR rather than by a claim, so it returns once the floor elapses.
    vi.useFakeTimers();
    try {
      act(() => {
        result.current.recordObservations([
          { taskId: "t1", status: "working" },
        ]);
      });
      expect(result.current.dueTaskIds(["t1"])).toEqual([]);
      vi.advanceTimersByTime(1_000);
      expect(result.current.dueTaskIds(["t1"])).toEqual(["t1"]);

      // A failed read releases it too, so the backoff is eventually retried
      // rather than stranded behind a claim nobody holds any more.
      act(() => {
        result.current.recordErrors(["t1"]);
      });
      vi.advanceTimersByTime(60_000);
      expect(result.current.dueTaskIds(["t1"])).toEqual(["t1"]);

      // And a read that reached neither is released explicitly. Claiming
      // reserves as well, so the handle is still withheld by its floor
      // afterwards — which is what stops an abandoned read from becoming a hot
      // retry loop — but it is no longer withheld forever.
      act(() => {
        result.current.release(["t1"]);
      });
      expect(result.current.dueTaskIds(["t1"])).toEqual([]);
      vi.advanceTimersByTime(1_000);
      expect(result.current.dueTaskIds(["t1"])).toEqual(["t1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets the user's preference undercut the server floor", () => {
    // The user asked for 500ms; the server asked for 60s. The server wins.
    const { result } = scheduler(500);
    result.current.dueTaskIds(["t1"]);
    act(() => {
      result.current.recordObservations([
        { taskId: "t1", status: "working", pollIntervalMs: 60_000 },
      ]);
    });
    expect(result.current.dueTaskIds(["t1"])).toEqual([]);
    expect(result.current.msUntilNextDue()).toBeGreaterThan(500);
  });

  it("applies a surface floor even when the server advertises none", () => {
    // Fake timers because this assertion has ZERO slack: `msUntilNextDue()` is
    // `nextPollAt - now`, the floor puts `nextPollAt` at exactly `now + 5000`,
    // and a single millisecond of real wall-clock between the two lines makes
    // it 4999. It flaked in CI for exactly that reason.
    vi.useFakeTimers();
    try {
      const { result } = scheduler(100, 5_000);
      result.current.dueTaskIds(["t1"]);
      act(() => {
        result.current.recordObservations([
          { taskId: "t1", status: "working" },
        ]);
      });
      // Asserted against the SURFACE floor specifically: a weaker
      // `toBeGreaterThan(100)` would pass on the engine's 250ms absolute floor
      // alone and prove nothing about the 5s hosted floor.
      expect(result.current.msUntilNextDue()).toBe(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops scheduling a terminal task", () => {
    const { result } = scheduler();
    result.current.dueTaskIds(["t1"]);
    act(() => {
      result.current.recordObservations([
        { taskId: "t1", status: "completed" },
      ]);
    });
    expect(result.current.dueTaskIds(["t1"])).toEqual([]);
  });

  it("gives a batch the SLOWEST member's floor", () => {
    const { result } = scheduler();
    result.current.dueTaskIds(["a", "b"]);
    act(() => {
      result.current.recordObservations([
        { taskId: "a", status: "working", pollIntervalMs: 1_000 },
        { taskId: "b", status: "working", pollIntervalMs: 9_000 },
      ]);
    });
    expect(result.current.batchIntervalMs(["a", "b"])).toBe(9_000);
  });

  it("backs off a failed read without changing the task's status", () => {
    vi.useFakeTimers();
    try {
      const { result } = scheduler(100);
      result.current.dueTaskIds(["t1"]);
      act(() => {
        result.current.recordObservations([
          { taskId: "t1", status: "working" },
        ]);
        result.current.recordErrors(["t1"]);
        result.current.recordErrors(["t1"]);
      });

      // Two consecutive errors ⇒ the backoff exceeds the user's 100ms floor.
      expect(result.current.msUntilNextDue()).toBeGreaterThanOrEqual(2_000);

      // ...and the handle is still SCHEDULED once the backoff expires. A
      // transport failure says nothing about the task, so it must not have
      // been marked terminal.
      vi.advanceTimersByTime(10_000);
      expect(result.current.dueTaskIds(["t1"])).toEqual(["t1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mirrors scheduling state into the tracker so a reload resumes", () => {
    trackTask({
      taskId: "t1",
      serverId: "s1",
      wire: "extension",
      createdAt: NOW,
    });
    const { result } = scheduler();
    result.current.dueTaskIds(["t1"]);
    act(() => {
      result.current.recordObservations([
        {
          taskId: "t1",
          status: "working",
          pollIntervalMs: 5_000,
          ttlMs: 60_000,
          lastUpdatedAt: "2026-07-28T00:05:00Z",
        },
      ]);
    });

    expect(getTrackedTasks()[0]).toMatchObject({
      status: "working",
      pollIntervalMs: 5_000,
      ttlMs: 60_000,
      lastUpdatedAt: "2026-07-28T00:05:00Z",
    });
    expect(getTrackedTasks()[0].nextPollAt).toBeGreaterThan(0);
  });

  it("schedules nothing when the connection has no tasks wire", () => {
    const { result } = renderHook(() =>
      useTaskScheduler({
        serverId: "s1",
        wire: "none",
        userMinimumIntervalMs: 1_000,
      })
    );
    expect(result.current.dueTaskIds(["t1"])).toEqual([]);
  });

  it("keeps handles apart per server", () => {
    const first = scheduler();
    const second = renderHook(() =>
      useTaskScheduler({
        serverId: "s2",
        wire: "extension",
        userMinimumIntervalMs: 1_000,
      })
    );

    first.result.current.dueTaskIds(["t1"]);
    act(() => {
      first.result.current.recordObservations([
        { taskId: "t1", status: "working", pollIntervalMs: 60_000 },
      ]);
    });

    // Same task id, different server: a separate handle, still due.
    expect(second.result.current.dueTaskIds(["t1"])).toEqual(["t1"]);
  });

  // ---- Resume after a reload ------------------------------------------------

  it("does NOT treat a restored handle as due when its stored floor has not elapsed", () => {
    trackTask({
      taskId: "t1",
      serverId: "s1",
      wire: "extension",
      createdAt: NOW,
    });
    recordTaskObservation(
      { taskId: "t1", serverId: "s1", wire: "extension" },
      {
        status: "working",
        pollIntervalMs: 60_000,
        nextPollAt: Date.now() + 60_000,
        lastObservedAt: Date.now(),
      }
    );

    // A FRESH hook — the engine is empty, exactly as after a page reload.
    const { result } = scheduler();
    expect(result.current.dueTaskIds(["t1"])).toEqual([]);
  });

  it("treats a restored handle as due once its stored floor has passed", () => {
    trackTask({
      taskId: "t1",
      serverId: "s1",
      wire: "extension",
      createdAt: NOW,
    });
    recordTaskObservation(
      { taskId: "t1", serverId: "s1", wire: "extension" },
      { status: "working", nextPollAt: Date.now() - 1_000 }
    );

    const { result } = scheduler();
    expect(result.current.dueTaskIds(["t1"])).toEqual(["t1"]);
  });

  it("treats a handle with no persisted schedule as due — nothing to resume", () => {
    trackTask({
      taskId: "fresh",
      serverId: "s1",
      wire: "extension",
      createdAt: NOW,
    });
    const { result } = scheduler();
    expect(result.current.dueTaskIds(["fresh"])).toEqual(["fresh"]);
  });

  it("persists responded input keys and restores them across a reload", () => {
    trackTask({
      taskId: "t1",
      serverId: "s1",
      wire: "extension",
      createdAt: NOW,
    });
    const first = scheduler();
    act(() => {
      first.result.current.markInputResponded("t1", ["ask-city"]);
    });

    // A fresh hook must not re-prompt for a key the server already
    // acknowledged.
    const second = scheduler();
    expect(second.result.current.respondedInputKeys("t1")).toEqual([
      "ask-city",
    ]);
  });

  it("reads a restored TERMINAL extension handle exactly once, then stops", () => {
    trackTask({
      taskId: "t1",
      serverId: "s1",
      wire: "extension",
      createdAt: NOW,
    });
    recordTaskObservation(
      { taskId: "t1", serverId: "s1", wire: "extension" },
      { status: "completed" }
    );

    const { result } = scheduler();

    // ONE recovery read. The tracker persists a task's status but never its
    // payload, and on the extension wire the result rides inline on
    // `tasks/get` — there is no `tasks/result` to fetch it from later. So a
    // handle restored as `completed` has a status with nothing behind it, and
    // never polling it would leave the row showing "completed" with no result
    // and no way to ever get one.
    expect(result.current.dueTaskIds(["t1"])).toEqual(["t1"]);

    // ...and the read settles the debt. From here the ordinary terminal
    // exclusion applies: the payload is in hand, so re-reading it is pure
    // waste against a server that already answered.
    act(() => {
      result.current.recordObservations([
        { taskId: "t1", status: "completed" },
      ]);
    });
    expect(result.current.dueTaskIds(["t1"])).toEqual([]);
  });

  it("does not re-read a restored terminal LEGACY handle", () => {
    trackTask({
      taskId: "t1",
      serverId: "s1",
      wire: "legacy",
      createdAt: NOW,
    });
    recordTaskObservation(
      { taskId: "t1", serverId: "s1", wire: "legacy" },
      { status: "completed" }
    );

    // Legacy does not have the extension's problem: its result comes from a
    // separate `tasks/result` call the tab makes on demand, so the recovery
    // read would buy nothing and cost a request.
    const { result } = renderHook(() =>
      useTaskScheduler({
        serverId: "s1",
        wire: "legacy",
        userMinimumIntervalMs: 1_000,
      })
    );
    expect(result.current.dueTaskIds(["t1"])).toEqual([]);
  });

  it("backs a failed terminal-recovery read off instead of retrying every tick", () => {
    vi.useFakeTimers();
    try {
      trackTask({
        taskId: "t1",
        serverId: "s1",
        wire: "extension",
        createdAt: NOW,
      });
      recordTaskObservation(
        { taskId: "t1", serverId: "s1", wire: "extension" },
        { status: "completed" }
      );

      const { result } = scheduler();
      expect(result.current.dueTaskIds(["t1"])).toEqual(["t1"]);

      // The recovery read failed. It still owes a read, but the backoff has to
      // govern it — otherwise an unreachable server is hammered once per tick
      // by a handle that will never come back.
      act(() => {
        result.current.recordErrors(["t1"]);
      });
      expect(result.current.dueTaskIds(["t1"])).toEqual([]);

      vi.advanceTimersByTime(60_000);
      expect(result.current.dueTaskIds(["t1"])).toEqual(["t1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists the backoff, so a reload cannot walk through it", () => {
    trackTask({
      taskId: "t1",
      serverId: "s1",
      wire: "extension",
      createdAt: NOW,
    });
    const first = scheduler(100);
    first.result.current.dueTaskIds(["t1"]);
    act(() => {
      first.result.current.recordObservations([
        { taskId: "t1", status: "working" },
      ]);
      first.result.current.recordErrors(["t1"]);
      first.result.current.recordErrors(["t1"]);
      first.result.current.recordErrors(["t1"]);
    });

    // A fresh hook — as after a reload during the backoff. Persisting only
    // successful observations left the tracker holding the elapsed
    // `nextPollAt` from the last good read, so the handle came back due at
    // once and repeated reloads bypassed the backoff entirely.
    const second = scheduler(100);
    expect(second.result.current.dueTaskIds(["t1"])).toEqual([]);
  });

  it("drops records for the previous server when the selection changes", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ serverId }: { serverId: string }) =>
          useTaskScheduler({
            serverId,
            wire: "extension",
            userMinimumIntervalMs: 1_000,
          }),
        { initialProps: { serverId: "s1" } }
      );

      result.current.dueTaskIds(["t1"]);
      act(() => {
        result.current.recordObservations([
          { taskId: "t1", status: "working", pollIntervalMs: 1_000 },
        ]);
      });

      rerender({ serverId: "s2" });
      vi.advanceTimersByTime(5_000);

      // The old server's record would otherwise still answer `due()` — nothing
      // on the new connection ever observes or forgets it, so
      // `msUntilNextDue()` would sit at zero for the rest of the session and
      // every re-arm would collapse to the floor.
      expect(result.current.msUntilNextDue()).toBeGreaterThanOrEqual(1_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
