import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskPanelApi } from "../task-panel-api";
import { getTask, getTasksBatch } from "../apis/mcp-tasks-api";
import {
  getOwnedTaskScope,
  getTrackedTasks,
  setTrackedTaskOwner,
  setTrackedTaskScope,
  trackTask,
} from "../task-tracker";

vi.mock("../apis/mcp-tasks-api", async (original) => ({
  ...(await original<typeof import("../apis/mcp-tasks-api")>()),
  getTask: vi.fn(async () => ({ wire: "extension", task: {} })),
  getTasksBatch: vi.fn(),
}));

describe("scoped Task panels", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    setTrackedTaskScope("project");
    setTrackedTaskOwner("project", "owner");
  });
  const handle = {
    taskId: "same",
    serverId: "canonical",
    wire: "extension" as const,
    createdAt: new Date().toISOString(),
  };

  it("keeps polling and clearing one account separate from another", async () => {
    trackTask({ ...handle, connectionId: "a" });
    trackTask({ ...handle, connectionId: "b" });
    const target = {
      serverId: "canonical",
      scope: getOwnedTaskScope()!,
      connectionId: "a",
    };
    const panel = taskPanelApi(target, "extension");
    expect(panel.getTrackedTasksForServer("Display")).toHaveLength(1);
    await panel.getTask("Display", "same");
    expect(getTask).toHaveBeenCalledWith("canonical", "same", {
      connectionId: "a",
      ownerScope: target.scope,
      wire: "extension",
    });
    panel.clearTrackedTasksForServer("Display");
    expect(getTrackedTasks().map((task) => task.connectionId)).toEqual(["b"]);
  });

  it("carries each Task's source into its control request", async () => {
    trackTask({ ...handle, sourceExecutionId: "receipt-a" });
    const panel = taskPanelApi(
      { serverId: "canonical", scope: getOwnedTaskScope()! },
      "extension",
    );
    await panel.getTask("Display", "same");
    expect(getTask).toHaveBeenLastCalledWith(
      "canonical",
      "same",
      expect.objectContaining({ sourceExecutions: { same: "receipt-a" } }),
    );
  });

  it("keeps successful Task reads when another source is refused", async () => {
    trackTask({ ...handle, taskId: "a", sourceExecutionId: "receipt-a" });
    trackTask({ ...handle, taskId: "b", sourceExecutionId: "receipt-b" });
    vi.mocked(getTasksBatch)
      .mockResolvedValueOnce({
        wire: "extension",
        tasks: [{ taskId: "a", task: { status: "working" } }],
      })
      .mockRejectedValueOnce(new Error("Forbidden"));
    const panel = taskPanelApi(
      { serverId: "canonical", scope: getOwnedTaskScope()! },
      "extension",
    );
    const result = await panel.getTasksBatch("Display", ["a", "b"]);
    expect(result.tasks).toEqual([
      { taskId: "a", task: { status: "working" } },
      { taskId: "b", error: expect.any(String) },
    ]);
    expect(getTasksBatch).toHaveBeenNthCalledWith(
      1,
      "canonical",
      ["a"],
      expect.objectContaining({ sourceExecutions: { a: "receipt-a" } }),
    );
    expect(getTasksBatch).toHaveBeenNthCalledWith(
      2,
      "canonical",
      ["b"],
      expect.objectContaining({ sourceExecutions: { b: "receipt-b" } }),
    );
  });

  it("uses an explicit owner for provenance-only handles", () => {
    trackTask({ ...handle, sourceExecutionId: "execution" });
    trackTask({ ...handle, serverId: "Display" });
    const panel = taskPanelApi(
      { serverId: "canonical", scope: getOwnedTaskScope()! },
      "extension",
    );
    expect(
      panel
        .getTrackedTasksForServer("Display")
        .map((task) => task.sourceExecutionId),
    ).toEqual(["execution"]);
    panel.clearTrackedTasksForServer("Display");
    expect(getTrackedTasks().map((task) => task.serverId)).toEqual(["Display"]);
  });

  it("captures the target before a later caller mutation or actor switch", async () => {
    const target = {
      serverId: "canonical",
      scope: getOwnedTaskScope()!,
      connectionId: "a",
    };
    const panel = taskPanelApi(target, "extension");
    const originalScope = target.scope;
    target.serverId = "other";
    target.scope = "other";
    target.connectionId = "b";
    setTrackedTaskOwner("project", "next-owner");
    await panel.getTask("Display", "same");
    expect(getTask).toHaveBeenCalledWith("canonical", "same", {
      connectionId: "a",
      ownerScope: originalScope,
      wire: "extension",
    });
  });
  it("snapshots storage reads and clears as well as RPC targets", () => {
    for (const connectionId of ["a", "b"])
      trackTask({ ...handle, connectionId });
    const target = {
      serverId: "canonical",
      scope: getOwnedTaskScope()!,
      connectionId: "a",
    };
    const panel = taskPanelApi(target, "extension");
    target.serverId = "different";
    target.connectionId = "b";
    target.scope = "wrong-owner";
    expect(
      panel
        .getTrackedTasksForServer("Display")
        .map((task) => task.connectionId),
    ).toEqual(["a"]);
    panel.clearTrackedTasksForServer("Display");
    expect(getTrackedTasks().map((task) => task.connectionId)).toEqual(["b"]);
  });
});
