import { beforeEach, describe, expect, it } from "vitest";
import {
  getTrackedTasks,
  getTrackedTasksForServer,
  markTaskExpired,
  trackTask,
  untrackTask,
} from "../task-tracker";

const STORAGE_KEY = "mcp-tracked-tasks";

describe("task-tracker", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("migrates v1 bare-array entries to legacy-tagged records", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { taskId: "old-1", serverId: "s1", createdAt: "2026-01-01" },
      ]),
    );

    expect(getTrackedTasks()).toEqual([
      {
        taskId: "old-1",
        serverId: "s1",
        wire: "legacy",
        createdAt: "2026-01-01",
      },
    ]);
  });

  it("keys identity on (serverId, wire, taskId)", () => {
    const base = { taskId: "t1", createdAt: "2026-01-01" };
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
      createdAt: "2026-01-01",
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
      createdAt: "2026-01-01",
    });

    markTaskExpired("t1", "s1");
    expect(getTrackedTasks()[0].expired).toBe(true);

    untrackTask("t1", "s1");
    expect(getTrackedTasks()).toHaveLength(0);
  });

  it("scopes untracking to the given server", () => {
    trackTask({
      taskId: "t1",
      serverId: "s1",
      wire: "legacy",
      createdAt: "2026-01-01",
    });
    trackTask({
      taskId: "t1",
      serverId: "s2",
      wire: "legacy",
      createdAt: "2026-01-01",
    });

    untrackTask("t1", "s1");
    expect(getTrackedTasks().map((t) => t.serverId)).toEqual(["s2"]);
  });
});
