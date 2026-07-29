import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hosted tools/execute route's recovery-index write: when a tool call
 * creates a task on either wire, the route fires a best-effort registry
 * upsert — after the CreateTaskResult is already in hand, never awaited, and
 * never able to fail the call. A non-task result writes nothing, and chatbox
 * visitors (not project members) are skipped entirely. There is deliberately
 * NO guest branch — see the backend route header: guests are not a special
 * case.
 *
 * The MRTR wrapper is stubbed with the same faithful miniature as
 * tools.tasks-wire-error.test.ts.
 */

let managerImpl: Record<string, unknown> = {};

vi.mock("../mrtr-direct.js", () => ({
  runHostedDirectMrtrOperation: async (
    c: any,
    schema: any,
    _meta: unknown,
    runVerb: (
      manager: any,
      body: any,
      forwardLogMessages: (serverId: string) => void,
    ) => Promise<unknown>,
  ) => {
    const { WebRouteError } = await import("../errors.js");
    const parsed = schema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: { code: "VALIDATION_ERROR" } }, 400);
    }
    try {
      const result = await runVerb(managerImpl, parsed.data, () => {});
      return c.json(result as Record<string, unknown>, 200);
    } catch (error) {
      if (error instanceof WebRouteError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }
      return c.json({ error: { code: "INTERNAL_ERROR" } }, 500);
    }
  },
}));

vi.mock("../../../utils/analytics.js", () => ({
  captureServerEvent: vi.fn(),
}));

const mockRecordCreatedTask = vi.fn();
vi.mock("../../../services/hosted-task-registry.js", () => ({
  recordCreatedTask: (...args: unknown[]) => mockRecordCreatedTask(...args),
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: vi.fn().mockResolvedValue("convex-jwt"),
}));

const toolsRoute = (await import("../tools.js")).default;

function post(body: Record<string, unknown>) {
  return toolsRoute.request("/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: "p1",
      serverId: "s1",
      toolName: "slow_tool",
      parameters: {},
      ...body,
    }),
  });
}

function setManager(overrides: Record<string, unknown>) {
  managerImpl = overrides;
}

/** Lets the deliberately-dangling registry promise settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const CREATED_AT = "2026-07-28T10:00:00.000Z";

describe("hosted tools/execute registry write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordCreatedTask.mockResolvedValue(true);
  });

  it("records a legacy-wire task creation (nested task envelope)", async () => {
    setManager({
      executeTool: vi.fn().mockResolvedValue({
        task: { taskId: "task-1", status: "working", createdAt: CREATED_AT },
      }),
      getTasksSupport: vi.fn().mockReturnValue({ wire: "legacy" }),
    });

    const res = await post({ taskOptions: { ttl: 60_000 } });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("task_created");
    await vi.waitFor(() =>
      expect(mockRecordCreatedTask).toHaveBeenCalledTimes(1),
    );
    expect(mockRecordCreatedTask).toHaveBeenCalledWith(
      { bearer: "convex-jwt", projectId: "p1", serverId: "s1" },
      {
        wire: "legacy",
        taskId: "task-1",
        status: "working",
        createdAt: Date.parse(CREATED_AT),
      },
    );
  });

  it("records an extension-wire task creation (flat CreateTaskResult)", async () => {
    setManager({
      executeTool: vi.fn().mockResolvedValue({
        resultType: "task",
        taskId: "task-ext",
        // Hyphenated on the wire; normalized before it reaches the registry.
        status: "input-required",
        createdAt: CREATED_AT,
      }),
      getTasksSupport: vi.fn().mockReturnValue({ wire: "extension" }),
    });

    const res = await post({ allowTaskResult: true });

    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(mockRecordCreatedTask).toHaveBeenCalledTimes(1),
    );
    expect(mockRecordCreatedTask).toHaveBeenCalledWith(
      { bearer: "convex-jwt", projectId: "p1", serverId: "s1" },
      {
        wire: "extension",
        taskId: "task-ext",
        status: "input_required",
        createdAt: Date.parse(CREATED_AT),
      },
    );
  });

  it("never fails the tool call when the registry write fails", async () => {
    setManager({
      executeTool: vi.fn().mockResolvedValue({
        task: { taskId: "task-1", status: "working" },
      }),
      getTasksSupport: vi.fn().mockReturnValue({ wire: "legacy" }),
    });
    mockRecordCreatedTask.mockRejectedValue(new Error("registry down"));

    const res = await post({ taskOptions: { ttl: 60_000 } });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("task_created");
    // Let the dangling promise settle so an uncontained rejection would
    // surface as an unhandled error and fail the suite.
    await flush();
  });

  it("skips the registry for chatbox-scoped callers", async () => {
    setManager({
      executeTool: vi.fn().mockResolvedValue({
        task: { taskId: "task-1", status: "working" },
      }),
      getTasksSupport: vi.fn().mockReturnValue({ wire: "legacy" }),
    });

    const res = await post({
      taskOptions: { ttl: 60_000 },
      accessScope: "chat_v2",
    });

    expect(res.status).toBe(200);
    await flush();
    expect(mockRecordCreatedTask).not.toHaveBeenCalled();
  });

  it("writes nothing for a non-task result", async () => {
    setManager({
      executeTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "done immediately" }],
      }),
      getTasksSupport: vi.fn().mockReturnValue({ wire: "legacy" }),
    });

    const res = await post({});

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("completed");
    await flush();
    expect(mockRecordCreatedTask).not.toHaveBeenCalled();
  });
});
