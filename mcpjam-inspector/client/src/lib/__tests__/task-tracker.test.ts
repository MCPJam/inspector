import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTrackedTasksForScope,
  dismissRegistryTasks,
  getDismissedTaskIds,
  getRespondedInputKeys,
  recordRespondedInputKeys,
  recordTaskObservation,
  getTrackedTasks,
  getTrackedTasksForServer,
  markTaskExpired,
  trackTask,
  setTrackedTaskScope,
  untrackTask,
} from "../task-tracker";

const STORAGE_KEY = "mcp-tracked-tasks";
// Handles are pruned after 7 days, so fixtures must be dated relative to now.
const NOW = new Date().toISOString();

describe("task-tracker", () => {
  beforeEach(() => {
    localStorage.clear();
    setTrackedTaskScope(undefined);
  });

  it("migrates v1 bare-array entries to legacy-tagged records", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ taskId: "old-1", serverId: "s1", createdAt: NOW }])
    );

    expect(getTrackedTasks()).toEqual([
      {
        taskId: "old-1",
        serverId: "s1",
        wire: "legacy",
        createdAt: NOW,
      },
    ]);
  });

  it("keys identity on (serverId, wire, taskId)", () => {
    const base = { taskId: "t1", createdAt: NOW };
    trackTask({ ...base, serverId: "s1", wire: "legacy" });
    trackTask({ ...base, serverId: "s1", wire: "legacy" });
    trackTask({ ...base, serverId: "s1", wire: "extension" });
    trackTask({ ...base, serverId: "s2", wire: "legacy" });

    expect(getTrackedTasks()).toHaveLength(3);
    expect(getTrackedTasksForServer("s1")).toHaveLength(2);
    expect(getTrackedTasksForServer("s1", "extension")).toHaveLength(1);
  });

  it("persists under a versioned schema", () => {
    trackTask({
      taskId: "t1",
      serverId: "s1",
      wire: "extension",
      createdAt: NOW,
    });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
    expect(stored.version).toBe(3);
    expect(stored.tasks).toHaveLength(1);
  });

  it("marks a task expired without dropping the handle", () => {
    trackTask({
      taskId: "t1",
      serverId: "s1",
      wire: "extension",
      createdAt: NOW,
    });

    markTaskExpired("t1", "s1");
    expect(getTrackedTasks()[0].expired).toBe(true);

    untrackTask("t1", "s1");
    expect(getTrackedTasks()).toHaveLength(0);
  });

  it("prunes handles older than the max age on load", () => {
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        tasks: [
          { taskId: "old", serverId: "s1", wire: "legacy", createdAt: stale },
          { taskId: "new", serverId: "s1", wire: "legacy", createdAt: NOW },
        ],
      })
    );

    expect(getTrackedTasks().map((t) => t.taskId)).toEqual(["new"]);
  });

  it("keeps handles from other actors out of the current scope", () => {
    setTrackedTaskScope("project-a");
    trackTask({ taskId: "t1", serverId: "s1", wire: "legacy", createdAt: NOW });

    setTrackedTaskScope("project-b");
    expect(getTrackedTasks()).toHaveLength(0);
    trackTask({ taskId: "t1", serverId: "s1", wire: "legacy", createdAt: NOW });
    expect(getTrackedTasks().map((t) => t.scope)).toEqual(["project-b"]);

    // A write in one scope must not delete the other scope's handles.
    setTrackedTaskScope("project-a");
    expect(getTrackedTasks().map((t) => t.scope)).toEqual(["project-a"]);
  });

  it("persists an explicit foreign-scope write under ITS scope, not the active one", () => {
    // A chat turn submitted under project-a can deliver its task-created part
    // after the user switched to project-b. The caller passes the turn-start
    // scope explicitly; the write must land under project-a.
    setTrackedTaskScope("project-b");
    trackTask({
      taskId: "t1",
      serverId: "s1",
      wire: "extension",
      createdAt: NOW,
      scope: "project-a",
    });

    // Invisible under the active scope (project-b)...
    expect(getTrackedTasks()).toHaveLength(0);
    // ...visible after switching to the scope it belongs to.
    setTrackedTaskScope("project-a");
    expect(getTrackedTasks().map((t) => t.scope)).toEqual(["project-a"]);
  });

  it("dedupes a foreign-scope write against the entry already on disk in that scope", () => {
    // The pre-fix dedupe only consulted the ACTIVE scope's slice, so an
    // identical foreign-scope write slipped past it and duplicated the entry
    // on disk. The dedupe must consult every scope.
    setTrackedTaskScope("project-a");
    trackTask({ taskId: "t1", serverId: "s1", wire: "extension", createdAt: NOW });

    setTrackedTaskScope("project-b");
    trackTask({
      taskId: "t1",
      serverId: "s1",
      wire: "extension",
      createdAt: NOW,
      scope: "project-a",
    });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
    expect(stored.tasks).toHaveLength(1);
    setTrackedTaskScope("project-a");
    expect(getTrackedTasks()).toHaveLength(1);
  });

  it("a foreign-scope write preserves every other scope's handles", () => {
    setTrackedTaskScope("project-a");
    trackTask({ taskId: "a1", serverId: "s1", wire: "legacy", createdAt: NOW });
    setTrackedTaskScope("project-b");
    trackTask({ taskId: "b1", serverId: "s1", wire: "legacy", createdAt: NOW });

    // Still in project-b: write a NEW handle back into project-a.
    trackTask({
      taskId: "a2",
      serverId: "s1",
      wire: "legacy",
      createdAt: NOW,
      scope: "project-a",
    });

    expect(getTrackedTasks().map((t) => t.taskId)).toEqual(["b1"]);
    setTrackedTaskScope("project-a");
    expect(getTrackedTasks().map((t) => t.taskId).sort()).toEqual(["a1", "a2"]);
  });

  it("caps the active scope at 50, evicting its own oldest handle", () => {
    for (let i = 0; i <= 50; i++) {
      trackTask({
        taskId: `t${i}`,
        serverId: "s1",
        wire: "legacy",
        createdAt: NOW,
      });
    }

    const ids = getTrackedTasks().map((t) => t.taskId);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe("t50");
    expect(ids).not.toContain("t0");
  });

  it("a late foreign-scope write caps ITS OWN scope, never the active one", () => {
    // Fill project-a to the cap, then project-b to the cap.
    setTrackedTaskScope("project-a");
    for (let i = 0; i < 50; i++) {
      trackTask({
        taskId: `a${i}`,
        serverId: "s1",
        wire: "extension",
        createdAt: NOW,
      });
    }
    setTrackedTaskScope("project-b");
    for (let i = 0; i < 50; i++) {
      trackTask({
        taskId: `b${i}`,
        serverId: "s1",
        wire: "extension",
        createdAt: NOW,
      });
    }

    // A delayed project-a task arrives while project-b is active. Pre-fix
    // the cap ran over the ACTIVE slice: project-b's oldest handle (b0) was
    // evicted — an evicted extension handle is locally unrecoverable — while
    // project-a grew past the cap.
    trackTask({
      taskId: "a-late",
      serverId: "s1",
      wire: "extension",
      createdAt: NOW,
      scope: "project-a",
    });

    // Every project-b handle survived, including its oldest.
    const bIds = getTrackedTasks().map((t) => t.taskId);
    expect(bIds).toHaveLength(50);
    expect(bIds).toContain("b0");

    // The eviction happened in the DESTINATION scope: a-late is in,
    // project-a's oldest is out, and the slice is still at the cap.
    setTrackedTaskScope("project-a");
    const aIds = getTrackedTasks().map((t) => t.taskId);
    expect(aIds).toHaveLength(50);
    expect(aIds[0]).toBe("a-late");
    expect(aIds).not.toContain("a0");
  });

  it("drops a scope's handles on logout / organization switch", () => {
    setTrackedTaskScope("project-a");
    trackTask({ taskId: "t1", serverId: "s1", wire: "legacy", createdAt: NOW });
    setTrackedTaskScope("project-b");
    trackTask({ taskId: "t2", serverId: "s1", wire: "legacy", createdAt: NOW });

    clearTrackedTasksForScope("project-a");

    expect(getTrackedTasks().map((t) => t.taskId)).toEqual(["t2"]);
    setTrackedTaskScope("project-a");
    expect(getTrackedTasks()).toHaveLength(0);
  });

  it("scopes untracking to the given server", () => {
    trackTask({
      taskId: "t1",
      serverId: "s1",
      wire: "legacy",
      createdAt: NOW,
    });
    trackTask({
      taskId: "t1",
      serverId: "s2",
      wire: "legacy",
      createdAt: NOW,
    });

    untrackTask("t1", "s1");
    expect(getTrackedTasks().map((t) => t.serverId)).toEqual(["s2"]);
  });
  // ---- v3: resumable scheduling state + responded input keys --------------

  it("resumes a handle's scheduling state across a reload", () => {
    const id = { taskId: "t1", serverId: "s1", wire: "extension" as const };
    trackTask({ ...id, createdAt: NOW });

    recordTaskObservation(id, {
      status: "working",
      lastUpdatedAt: "2026-07-28T00:05:00Z",
      ttlMs: 60_000,
      pollIntervalMs: 5_000,
      nextPollAt: 1_700_000_000_000,
      lastObservedAt: 1_699_999_995_000,
    });

    const [task] = getTrackedTasks();
    expect(task).toMatchObject({
      status: "working",
      lastUpdatedAt: "2026-07-28T00:05:00Z",
      ttlMs: 60_000,
      pollIntervalMs: 5_000,
      nextPollAt: 1_700_000_000_000,
      lastObservedAt: 1_699_999_995_000,
    });
  });

  it("lets a null ttlMs overwrite a number — null means 'no expiry', not 'unset'", () => {
    const id = { taskId: "t1", serverId: "s1", wire: "extension" as const };
    trackTask({ ...id, createdAt: NOW });

    recordTaskObservation(id, { ttlMs: 60_000 });
    expect(getTrackedTasks()[0].ttlMs).toBe(60_000);
    recordTaskObservation(id, { ttlMs: null });
    expect(getTrackedTasks()[0].ttlMs).toBeNull();
  });

  it("does not resurrect an untracked handle", () => {
    recordTaskObservation(
      { taskId: "ghost", serverId: "s1", wire: "extension" },
      { status: "working" }
    );
    expect(getTrackedTasks()).toHaveLength(0);
  });

  it("persists responded input KEYS and never a payload", () => {
    const id = { taskId: "t1", serverId: "s1", wire: "extension" as const };
    trackTask({ ...id, createdAt: NOW });

    recordRespondedInputKeys(id, ["ask-name"]);
    recordRespondedInputKeys(id, ["ask-name", "ask-email"]);

    expect(getRespondedInputKeys(id).sort()).toEqual(["ask-email", "ask-name"]);
    // The whole serialized store must contain no prompt or response content.
    const raw = localStorage.getItem(STORAGE_KEY) as string;
    expect(raw).not.toContain("elicitation");
    expect(raw).not.toContain("content");
  });

  it("keeps responded keys scoped to their own handle", () => {
    const a = { taskId: "t1", serverId: "s1", wire: "extension" as const };
    const b = { taskId: "t2", serverId: "s1", wire: "extension" as const };
    trackTask({ ...a, createdAt: NOW });
    trackTask({ ...b, createdAt: NOW });

    recordRespondedInputKeys(a, ["k"]);
    expect(getRespondedInputKeys(b)).toEqual([]);
  });

  it("does not carry responded keys across wires for the same task id", () => {
    const legacy = { taskId: "t1", serverId: "s1", wire: "legacy" as const };
    const extension = {
      taskId: "t1",
      serverId: "s1",
      wire: "extension" as const,
    };
    trackTask({ ...legacy, createdAt: NOW });
    trackTask({ ...extension, createdAt: NOW });

    recordRespondedInputKeys(legacy, ["k"]);
    expect(getRespondedInputKeys(extension)).toEqual([]);
  });

  // ---- Robustness against corrupt / hostile / future records --------------

  it("ignores a record written by a NEWER schema version outright", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 99,
        tasks: [
          { taskId: "t1", serverId: "s1", wire: "extension", createdAt: NOW },
        ],
      })
    );
    // Best-effort parsing a future record risks misreading fields whose meaning
    // changed; re-deriving from the server is strictly safer.
    expect(getTrackedTasks()).toHaveLength(0);
  });

  it("drops malformed entries but keeps the good ones beside them", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 3,
        tasks: [
          null,
          "nope",
          { serverId: "s1", wire: "extension", createdAt: NOW },
          { taskId: "good", serverId: "s1", wire: "extension", createdAt: NOW },
        ],
      })
    );
    expect(getTrackedTasks().map((t) => t.taskId)).toEqual(["good"]);
  });

  it("survives corrupt JSON instead of throwing on every page load", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(getTrackedTasks()).toEqual([]);
  });

  it("normalizes an unrecognized wire tag to legacy rather than trusting it", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 3,
        tasks: [
          { taskId: "t1", serverId: "s1", wire: "made-up", createdAt: NOW },
        ],
      })
    );
    expect(getTrackedTasks()[0].wire).toBe("legacy");
  });

  it("caps oversized DISPLAY strings from a hostile server", () => {
    const huge = "x".repeat(10_000);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 3,
        tasks: [
          {
            taskId: "t1",
            serverId: "s1",
            wire: "extension",
            createdAt: NOW,
            toolName: huge,
            primitiveName: huge,
          },
        ],
      })
    );
    const [task] = getTrackedTasks();
    expect(task.toolName?.length).toBe(1024);
    expect(task.primitiveName?.length).toBe(1024);
  });

  // Truncating an IDENTITY field does not shorten a value, it produces a
  // DIFFERENT handle — and collapses any two values sharing a 1024-character
  // prefix into one identity that shares `respondedInputKeys`/`nextPollAt`.
  // For `scope`, the auth/org segment, that collapse crosses accounts.
  it.each(["taskId", "serverId", "scope"])(
    "drops a record whose %s is over-length rather than truncating it",
    (field) => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 3,
          tasks: [
            {
              taskId: "t1",
              serverId: "s1",
              wire: "extension",
              createdAt: NOW,
              [field]: "x".repeat(10_000),
            },
          ],
        })
      );
      expect(getTrackedTasks()).toEqual([]);
    }
  );

  it("refuses to write an over-length identity in the first place", () => {
    // Rejected at the door rather than on the next load, so the handle does
    // not appear to work and then vanish at the next reload.
    trackTask({
      taskId: "x".repeat(10_000),
      serverId: "s1",
      wire: "extension",
      createdAt: NOW,
    });
    expect(getTrackedTasks()).toEqual([]);
  });

  it("caps the number of responded input keys it will retain", () => {
    const id = { taskId: "t1", serverId: "s1", wire: "extension" as const };
    trackTask({ ...id, createdAt: NOW });
    recordRespondedInputKeys(
      id,
      Array.from({ length: 500 }, (_, i) => `k${i}`)
    );
    expect(getRespondedInputKeys(id)).toHaveLength(100);
  });

  it("never drops a handle because its ttlMs elapsed", () => {
    const id = { taskId: "t1", serverId: "s1", wire: "extension" as const };
    trackTask({ ...id, createdAt: NOW });
    // A one-millisecond TTL, long since past. Discarding the task is the
    // SERVER's call (tasks.md:136-140); we keep the handle and keep polling.
    recordTaskObservation(id, {
      ttlMs: 1,
      lastObservedAt: Date.now() - 60_000,
    });
    expect(getTrackedTasks().map((t) => t.taskId)).toEqual(["t1"]);
  });

  it("sheds other scopes' handles before its own when the store is full", () => {
    // Seeded directly rather than through `trackTask`, because the trim halves
    // the payload and so leaves ~half the ceiling free afterwards — the public
    // API cannot easily park the store just under the limit. A browser gets
    // there over time; the test gets there in one write.
    const pad = "x".repeat(1000);
    const seeded = Array.from({ length: 260 }, (_, i) => ({
      taskId: `other-${i}-${pad}`.slice(0, 1000),
      serverId: `srv-${pad}`.slice(0, 1000),
      wire: "extension" as const,
      createdAt: new Date().toISOString(),
      dismissed: false,
      scope: "other-org",
    }));
    localStorage.setItem(
      "mcp-tracked-tasks",
      JSON.stringify({ version: 3, tasks: seeded })
    );

    setTrackedTaskScope("my-org");
    trackTask({
      taskId: "fresh",
      serverId: "srv",
      wire: "extension",
      createdAt: new Date().toISOString(),
    });

    // Adding this one task crosses the ceiling, so the trim runs. Out-of-scope
    // entries used to be concatenated FIRST and the trim sheds from the tail,
    // so the task created a moment ago was dropped while stale handles from a
    // scope nobody has open survived. Losing the handle the user is waiting on
    // is the worst outcome this store has.
    expect(getTrackedTasks().map((t) => t.taskId)).toEqual(["fresh"]);
  });

  describe("dismissed registry-only handles", () => {
    it("unions registry dismissals into getDismissedTaskIds without a tracker row", () => {
      trackTask({
        taskId: "tracked-1",
        serverId: "srv",
        wire: "extension",
        createdAt: NOW,
      });

      dismissRegistryTasks("srv", ["registry-1", "registry-2"]);

      const dismissed = getDismissedTaskIds("srv");
      expect(dismissed.has("registry-1")).toBe(true);
      expect(dismissed.has("registry-2")).toBe(true);
      // A view preference, not a tracker row: nothing was resurrected into
      // the task store for it.
      expect(getTrackedTasks().map((t) => t.taskId)).toEqual(["tracked-1"]);
    });

    it("scopes registry dismissals like the tracker rows", () => {
      setTrackedTaskScope("project-a");
      dismissRegistryTasks("srv", ["registry-1"]);

      setTrackedTaskScope("project-b");
      expect(getDismissedTaskIds("srv").has("registry-1")).toBe(false);

      setTrackedTaskScope("project-a");
      expect(getDismissedTaskIds("srv").has("registry-1")).toBe(true);
    });

    it("clearTrackedTasksForScope drops that scope's registry dismissals too", () => {
      setTrackedTaskScope("project-a");
      dismissRegistryTasks("srv", ["registry-1"]);
      setTrackedTaskScope("project-b");
      dismissRegistryTasks("srv", ["registry-2"]);

      clearTrackedTasksForScope("project-a");

      setTrackedTaskScope("project-a");
      expect(getDismissedTaskIds("srv").has("registry-1")).toBe(false);
      setTrackedTaskScope("project-b");
      expect(getDismissedTaskIds("srv").has("registry-2")).toBe(true);
    });
  });
});
