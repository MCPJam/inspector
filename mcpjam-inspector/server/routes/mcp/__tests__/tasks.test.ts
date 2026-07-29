import { describe, it, expect, vi } from "vitest";
import {
  createTestApp,
  createMockMcpClientManager,
  postJson,
  expectJson,
} from "./helpers";

const legacySupport = {
  wire: "legacy" as const,
  toolCalls: true,
  list: true,
  cancel: true,
  update: false,
  inlineResult: false,
};

const extensionSupport = {
  wire: "extension" as const,
  toolCalls: true,
  list: false,
  cancel: true,
  update: true,
  inlineResult: true,
};

const noSupport = {
  wire: "none" as const,
  toolCalls: false,
  list: false,
  cancel: false,
  update: false,
  inlineResult: false,
};

function appFor(
  support: typeof legacySupport | typeof extensionSupport | typeof noSupport,
  overrides: Record<string, unknown> = {},
) {
  const manager = createMockMcpClientManager({
    getTasksSupport: vi.fn().mockReturnValue(support),
    ...overrides,
  } as never);
  return { app: createTestApp(manager, "tasks"), manager };
}

describe("POST /api/mcp/tasks", () => {
  describe("/capabilities", () => {
    it("returns the full support object plus the legacy booleans", async () => {
      const { app } = appFor(legacySupport);
      const res = await postJson(app, "/api/mcp/tasks/capabilities", {
        serverId: "s1",
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(200);
      expect(data).toMatchObject({
        ...legacySupport,
        supportsToolCalls: true,
        supportsList: true,
        supportsCancel: true,
      });
    });

    it("requires serverId", async () => {
      const { app } = appFor(legacySupport);
      const res = await postJson(app, "/api/mcp/tasks/capabilities", {});
      expect(res.status).toBe(400);
    });
  });

  describe("/list", () => {
    it("tags legacy list results with the wire", async () => {
      const { app } = appFor(legacySupport, {
        listTasks: vi.fn().mockResolvedValue({ tasks: [{ taskId: "t1" }] }),
      });
      const { status, data } = await expectJson(
        await postJson(app, "/api/mcp/tasks/list", { serverId: "s1" }),
      );

      expect(status).toBe(200);
      expect(data).toEqual({ tasks: [{ taskId: "t1" }], wire: "legacy" });
    });

    it("answers locally without a network call on the extension wire", async () => {
      const listTasks = vi.fn();
      const { app } = appFor(extensionSupport, { listTasks });
      const { status, data } = await expectJson(
        await postJson(app, "/api/mcp/tasks/list", { serverId: "s1" }),
      );

      expect(status).toBe(200);
      expect(data).toEqual({ tasks: [], wire: "extension" });
      expect(listTasks).not.toHaveBeenCalled();
    });
  });

  describe("/get", () => {
    it("uses the legacy read and returns a wire-tagged envelope", async () => {
      const getTask = vi.fn().mockResolvedValue({ taskId: "t1" });
      const { app } = appFor(legacySupport, { getTask });
      const { status, data } = await expectJson(
        await postJson(app, "/api/mcp/tasks/get", {
          serverId: "s1",
          taskId: "t1",
        }),
      );

      expect(status).toBe(200);
      expect(data).toEqual({ wire: "legacy", task: { taskId: "t1" } });
      expect(getTask).toHaveBeenCalledWith("s1", "t1");
    });

    it("uses the extension read on the extension wire", async () => {
      const getTaskExt = vi
        .fn()
        .mockResolvedValue({ taskId: "t1", status: "working" });
      const { app } = appFor(extensionSupport, { getTaskExt });
      const { data } = await expectJson(
        await postJson(app, "/api/mcp/tasks/get", {
          serverId: "s1",
          taskId: "t1",
        }),
      );

      expect(data).toMatchObject({ wire: "extension" });
      expect(getTaskExt).toHaveBeenCalledWith("s1", "t1");
    });

    it("maps -32602 to a stable task-unknown-or-expired 404", async () => {
      const error = Object.assign(new Error("unknown task"), { code: -32602 });
      const { app } = appFor(extensionSupport, {
        getTaskExt: vi.fn().mockRejectedValue(error),
      });
      const { status, data } = await expectJson(
        await postJson(app, "/api/mcp/tasks/get", {
          serverId: "s1",
          taskId: "gone",
        }),
      );

      expect(status).toBe(404);
      expect(data.code).toBe("task-unknown-or-expired");
    });

    it("refuses to touch the network when there is no tasks wire", async () => {
      const getTask = vi.fn();
      const { app } = appFor(noSupport, { getTask });
      const res = await postJson(app, "/api/mcp/tasks/get", {
        serverId: "s1",
        taskId: "t1",
      });

      expect(res.status).toBe(400);
      expect(getTask).not.toHaveBeenCalled();
    });
  });

  describe("/result", () => {
    it("is rejected on the extension wire", async () => {
      const getTaskResult = vi.fn();
      const { app } = appFor(extensionSupport, { getTaskResult });
      const res = await postJson(app, "/api/mcp/tasks/result", {
        serverId: "s1",
        taskId: "t1",
      });

      expect(res.status).toBe(400);
      expect(getTaskResult).not.toHaveBeenCalled();
    });

    it("annotates the legacy result with the related-task meta", async () => {
      const { app } = appFor(legacySupport, {
        getTaskResult: vi.fn().mockResolvedValue({ content: [] }),
      });
      const { status, data } = await expectJson(
        await postJson(app, "/api/mcp/tasks/result", {
          serverId: "s1",
          taskId: "t1",
        }),
      );

      expect(status).toBe(200);
      expect(data._meta["io.modelcontextprotocol/related-task"]).toEqual({
        taskId: "t1",
      });
    });
  });

  describe("/update", () => {
    it("submits input responses on the extension wire", async () => {
      const updateTask = vi.fn().mockResolvedValue({ taskId: "t1" });
      const { app } = appFor(extensionSupport, { updateTask });
      const { status, data } = await expectJson(
        await postJson(app, "/api/mcp/tasks/update", {
          serverId: "s1",
          taskId: "t1",
          inputResponses: { key: { result: {} } },
        }),
      );

      expect(status).toBe(200);
      expect(data).toEqual({ wire: "extension", task: { taskId: "t1" } });
      expect(updateTask).toHaveBeenCalledWith("s1", "t1", {
        key: { result: {} },
      });
    });

    it("is rejected when the wire has no update operation", async () => {
      const updateTask = vi.fn();
      const { app } = appFor(legacySupport, { updateTask });
      const res = await postJson(app, "/api/mcp/tasks/update", {
        serverId: "s1",
        taskId: "t1",
        inputResponses: {},
      });

      expect(res.status).toBe(400);
      expect(updateTask).not.toHaveBeenCalled();
    });

    it("requires inputResponses", async () => {
      const { app } = appFor(extensionSupport, { updateTask: vi.fn() });
      const res = await postJson(app, "/api/mcp/tasks/update", {
        serverId: "s1",
        taskId: "t1",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("/cancel", () => {
    it("returns the cancelled task on the legacy wire", async () => {
      const { app } = appFor(legacySupport, {
        cancelTask: vi.fn().mockResolvedValue({ taskId: "t1" }),
      });
      const { data } = await expectJson(
        await postJson(app, "/api/mcp/tasks/cancel", {
          serverId: "s1",
          taskId: "t1",
        }),
      );

      expect(data).toEqual({ wire: "legacy", task: { taskId: "t1" } });
    });

    it("returns a null task for the empty extension ack", async () => {
      const cancelTaskExt = vi.fn().mockResolvedValue({});
      const { app } = appFor(extensionSupport, { cancelTaskExt });
      const { data } = await expectJson(
        await postJson(app, "/api/mcp/tasks/cancel", {
          serverId: "s1",
          taskId: "t1",
        }),
      );

      expect(data).toEqual({ wire: "extension", task: null });
      expect(cancelTaskExt).toHaveBeenCalledWith("s1", "t1");
    });

    it("is gated on the cancel capability", async () => {
      const { app } = appFor(
        { ...legacySupport, cancel: false },
        { cancelTask: vi.fn() },
      );
      const res = await postJson(app, "/api/mcp/tasks/cancel", {
        serverId: "s1",
        taskId: "t1",
      });
      expect(res.status).toBe(400);
    });
  });
});
