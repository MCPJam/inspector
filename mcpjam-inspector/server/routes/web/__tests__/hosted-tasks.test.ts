import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hosted task routes are thin: they own schema validation, the
 * connect/request/disconnect envelope, and the error mapping. We stub
 * `withEphemeralConnection` with a faithful miniature (parse → connect →
 * handler → disconnect → JSON) so the assertions are about THIS file's
 * behavior rather than about the shared auth plumbing, which has its own
 * tests.
 */

const lifecycle: string[] = [];
let managerImpl: Record<string, unknown> = {};

vi.mock("../auth.js", async () => {
  const actual =
    await vi.importActual<typeof import("../auth.js")>("../auth.js");
  const { WebRouteError, ErrorCode } = await import("../errors.js");

  return {
    ...actual,
    withEphemeralConnection: async (
      c: any,
      schema: any,
      fn: (manager: any, body: any) => Promise<unknown>,
    ) => {
      const parsed = schema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json(
          { error: { code: ErrorCode.VALIDATION_ERROR, message: "invalid" } },
          400,
        );
      }
      lifecycle.push("connect");
      try {
        const result = await fn(managerImpl, parsed.data);
        return c.json(result as Record<string, unknown>, 200);
      } catch (error) {
        if (error instanceof WebRouteError) {
          return c.json(
            {
              error: {
                code: error.code,
                message: error.message,
                ...(error.details ?? {}),
              },
            },
            error.status,
          );
        }
        return c.json({ error: { code: "INTERNAL_ERROR" } }, 500);
      } finally {
        lifecycle.push("disconnect");
      }
    },
  };
});

const tasksRoute = (await import("../tasks.js")).default;
const { HOSTED_TASK_BATCH_MAX } = await import("../auth.js");

const extensionSupport = {
  wire: "extension" as const,
  toolCalls: true,
  list: false,
  cancel: true,
  update: true,
  inlineResult: true,
};

const legacySupport = {
  wire: "legacy" as const,
  toolCalls: true,
  list: true,
  cancel: true,
  update: false,
  inlineResult: false,
};

function setManager(overrides: Record<string, unknown>) {
  managerImpl = {
    getTasksSupport: vi.fn().mockReturnValue(extensionSupport),
    ...overrides,
  };
  return managerImpl;
}

function post(path: string, body: Record<string, unknown>) {
  return tasksRoute.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: "p1", serverId: "s1", ...body }),
  });
}

const unknownTask = () =>
  vi.fn().mockRejectedValue(Object.assign(new Error("gone"), { code: -32602 }));

describe("hosted /api/web/tasks", () => {
  beforeEach(() => {
    lifecycle.length = 0;
    managerImpl = {};
  });

  it("connects, reads and disconnects for a single get", async () => {
    setManager({ getTaskExt: vi.fn().mockResolvedValue({ taskId: "t1" }) });

    const res = await post("/get", { taskId: "t1" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      wire: "extension",
      task: { taskId: "t1" },
    });
    expect(lifecycle).toEqual(["connect", "disconnect"]);
  });

  it("maps a forgotten task onto the stable TASK_NOT_FOUND code", async () => {
    setManager({ getTaskExt: unknownTask() });

    const res = await post("/get", { taskId: "gone" });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("TASK_NOT_FOUND");
    // The connection is still torn down on the error path.
    expect(lifecycle).toEqual(["connect", "disconnect"]);
  });

  describe("/get-batch", () => {
    it("reads every task over one connection", async () => {
      const getTaskExt = vi
        .fn()
        .mockImplementation(async (_s: string, taskId: string) => ({ taskId }));
      setManager({ getTaskExt });

      const res = await post("/get-batch", { taskIds: ["a", "b", "c"] });

      expect(await res.json()).toEqual({
        wire: "extension",
        tasks: [
          { taskId: "a", task: { taskId: "a" } },
          { taskId: "b", task: { taskId: "b" } },
          { taskId: "c", task: { taskId: "c" } },
        ],
      });
      expect(getTaskExt).toHaveBeenCalledTimes(3);
      expect(lifecycle).toEqual(["connect", "disconnect"]);
    });

    it("reports a forgotten task per-entry instead of failing the tick", async () => {
      const getTaskExt = vi
        .fn()
        .mockImplementationOnce(async () => ({ taskId: "a" }))
        .mockImplementationOnce(async () => {
          throw Object.assign(new Error("gone"), { code: -32602 });
        });
      setManager({ getTaskExt });

      const res = await post("/get-batch", { taskIds: ["a", "b"] });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.tasks[0].task).toEqual({ taskId: "a" });
      expect(body.tasks[1]).toMatchObject({
        taskId: "b",
        code: "task-unknown-or-expired",
      });
    });

    it("rejects a batch over the cap without connecting", async () => {
      const getTaskExt = vi.fn();
      setManager({ getTaskExt });

      const res = await post("/get-batch", {
        taskIds: Array.from(
          { length: HOSTED_TASK_BATCH_MAX + 1 },
          (_, i) => `t${i}`,
        ),
      });

      expect(res.status).toBe(400);
      expect(lifecycle).toEqual([]);
      expect(getTaskExt).not.toHaveBeenCalled();
    });

    it("accepts a batch exactly at the cap", async () => {
      setManager({
        getTaskExt: vi
          .fn()
          .mockImplementation(async (_s: string, taskId: string) => ({
            taskId,
          })),
      });

      const res = await post("/get-batch", {
        taskIds: Array.from(
          { length: HOSTED_TASK_BATCH_MAX },
          (_, i) => `t${i}`,
        ),
      });

      expect(res.status).toBe(200);
      expect((await res.json()).tasks).toHaveLength(HOSTED_TASK_BATCH_MAX);
    });
  });

  describe("capability gating", () => {
    it("answers /list locally on the extension wire", async () => {
      const listTasks = vi.fn();
      setManager({ listTasks });

      const res = await post("/list", {});

      expect(await res.json()).toEqual({ tasks: [], wire: "extension" });
      expect(listTasks).not.toHaveBeenCalled();
    });

    it("passes /list through on the legacy wire", async () => {
      setManager({
        getTasksSupport: vi.fn().mockReturnValue(legacySupport),
        listTasks: vi.fn().mockResolvedValue({ tasks: [{ taskId: "t1" }] }),
      });

      expect(await (await post("/list", {})).json()).toEqual({
        tasks: [{ taskId: "t1" }],
        wire: "legacy",
      });
    });

    it("refuses /result on the extension wire", async () => {
      const getTaskResult = vi.fn();
      setManager({ getTaskResult });

      const res = await post("/result", { taskId: "t1" });

      expect(res.status).toBe(500);
      expect(getTaskResult).not.toHaveBeenCalled();
    });

    it("refuses /update when the wire has no update operation", async () => {
      const updateTask = vi.fn();
      setManager({
        getTasksSupport: vi.fn().mockReturnValue(legacySupport),
        updateTask,
      });

      const res = await post("/update", { taskId: "t1", inputResponses: {} });

      expect(res.status).toBe(500);
      expect(updateTask).not.toHaveBeenCalled();
    });

    it("refuses /cancel when the server never declared cancellation", async () => {
      const cancelTaskExt = vi.fn();
      setManager({
        getTasksSupport: vi
          .fn()
          .mockReturnValue({ ...extensionSupport, cancel: false }),
        cancelTaskExt,
      });

      expect((await post("/cancel", { taskId: "t1" })).status).toBe(500);
      expect(cancelTaskExt).not.toHaveBeenCalled();
    });

    it("returns the empty extension cancel ack as a null task", async () => {
      setManager({ cancelTaskExt: vi.fn().mockResolvedValue({}) });

      expect(await (await post("/cancel", { taskId: "t1" })).json()).toEqual({
        wire: "extension",
        task: null,
      });
    });
  });

  it("submits input responses through /update", async () => {
    const updateTask = vi.fn().mockResolvedValue({ taskId: "t1" });
    setManager({ updateTask });

    const res = await post("/update", {
      taskId: "t1",
      inputResponses: { k: { result: {} } },
    });

    expect(await res.json()).toEqual({
      wire: "extension",
      task: { taskId: "t1" },
    });
    expect(updateTask).toHaveBeenCalledWith("s1", "t1", { k: { result: {} } });
  });

  it("exposes the full capability envelope plus the compat booleans", async () => {
    setManager({});

    expect(await (await post("/capabilities", {})).json()).toMatchObject({
      ...extensionSupport,
      supportsToolCalls: true,
      supportsList: false,
      supportsCancel: true,
    });
  });

  it("rejects a request missing the project/server identity", async () => {
    setManager({ getTaskExt: vi.fn() });

    const res = await tasksRoute.request("/get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: "t1" }),
    });

    expect(res.status).toBe(400);
    expect(lifecycle).toEqual([]);
  });
});
