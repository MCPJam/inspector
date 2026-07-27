import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTrackedTasksForScope,
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
      JSON.stringify([
        { taskId: "old-1", serverId: "s1", createdAt: NOW },
      ]),
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
    expect(stored.version).toBe(2);
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
      }),
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
});
