import { describe, expect, it, vi } from "vitest";
import {
  UnknownTaskError,
  detectCreatedTask,
  getTaskForWire,
  getTasksBatchForWire,
} from "../task-route-handlers.js";

const support = (wire: "none" | "legacy" | "extension") => ({
  wire,
  toolCalls: wire !== "none",
  list: wire === "legacy",
  cancel: wire !== "none",
  update: wire === "extension",
  inlineResult: wire === "extension",
});

function manager(wire: Parameters<typeof support>[0], rest = {}) {
  return {
    getTasksSupport: vi.fn().mockReturnValue(support(wire)),
    ...rest,
  } as never;
}

describe("task-route-handlers", () => {
  it("never touches the network when there is no tasks wire", async () => {
    const getTask = vi.fn();
    await expect(
      getTaskForWire(manager("none", { getTask }), {
        serverId: "s1",
        taskId: "t1",
      }),
    ).rejects.toThrow(/no tasks wire/);
    expect(getTask).not.toHaveBeenCalled();
  });

  it("translates -32602 into a typed UnknownTaskError carrying the wire", async () => {
    const getTask = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("gone"), { code: -32602 }));

    await expect(
      getTaskForWire(manager("legacy", { getTask }), {
        serverId: "s1",
        taskId: "t1",
      }),
    ).rejects.toMatchObject({
      code: "task-unknown-or-expired",
      wire: "legacy",
    });
  });

  it("propagates non -32602 failures untranslated", async () => {
    const getTask = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("boom"), { code: -32603 }));

    const error = await getTaskForWire(manager("legacy", { getTask }), {
      serverId: "s1",
      taskId: "t1",
    }).catch((e) => e);

    expect(error).not.toBeInstanceOf(UnknownTaskError);
    expect(error.message).toBe("boom");
  });

  it("uses the legacy read on the legacy wire", async () => {
    const getTask = vi.fn().mockResolvedValue({ taskId: "t1" });
    const getTaskExt = vi.fn();

    await getTaskForWire(manager("legacy", { getTask, getTaskExt }), {
      serverId: "s1",
      taskId: "t1",
    });

    expect(getTask).toHaveBeenCalledOnce();
    expect(getTaskExt).not.toHaveBeenCalled();
  });

  it("keeps batch reads going past a forgotten task", async () => {
    const getTaskExt = vi
      .fn()
      .mockImplementation(async (_s: string, id: string) => {
        if (id === "b") throw Object.assign(new Error("gone"), { code: -32602 });
        return { taskId: id };
      });

    const result = await getTasksBatchForWire(
      manager("extension", { getTaskExt }),
      { serverId: "s1", taskIds: ["a", "b", "c"] },
    );

    expect(result.tasks.map((t) => t.taskId)).toEqual(["a", "b", "c"]);
    expect(result.tasks[1].code).toBe("task-unknown-or-expired");
    expect(result.tasks[2].task).toEqual({ taskId: "c" });
  });

  it("fails the batch on a non-task error", async () => {
    const getTaskExt = vi.fn().mockRejectedValue(new Error("transport down"));

    await expect(
      getTasksBatchForWire(manager("extension", { getTaskExt }), {
        serverId: "s1",
        taskIds: ["a"],
      }),
    ).rejects.toThrow("transport down");
  });

  describe("detectCreatedTask", () => {
    it("recognizes the flat extension CreateTaskResult", () => {
      expect(
        detectCreatedTask(manager("extension"), "s1", {
          resultType: "task",
          taskId: "t1",
        }),
      ).toMatchObject({ status: "task_created", wire: "extension" });
    });

    it("recognizes the nested legacy task", () => {
      expect(
        detectCreatedTask(manager("legacy"), "s1", {
          task: { taskId: "t1", status: "working" },
        }),
      ).toMatchObject({ status: "task_created", task: { taskId: "t1" } });
    });

    it("passes a synchronous extension result through", () => {
      expect(
        detectCreatedTask(manager("extension"), "s1", {
          resultType: "complete",
          content: [],
        }),
      ).toBeNull();
    });

    it("never classifies anything as a task when the wire is none", () => {
      expect(
        detectCreatedTask(manager("none"), "s1", {
          task: { taskId: "t1", status: "working" },
        }),
      ).toBeNull();
    });
  });
});
