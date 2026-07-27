import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@/lib/session-token", () => ({
  authFetch: authFetchMock,
  resetTokenCache: () => {},
}));

import { setApiContext } from "@/lib/apis/web/context";
import {
  TaskUnknownOrExpiredError,
  cancelTask,
  getAllProgress,
  getLatestProgress,
  getTask,
  getTaskCapabilities,
  getTasksBatch,
  updateTask,
} from "../mcp-tasks-api";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response;
}

function lastCall(): { path: string; body: any } {
  const [path, init] = authFetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { path, body: JSON.parse(init.body as string) };
}

describe("mcp-tasks-api (hosted mode)", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    setApiContext({
      projectId: "project-1",
      isAuthenticated: true,
      serverIdsByName: { "my-server": "server-1" },
    } as never);
  });

  it("routes reads to the hosted task routes with the project/server envelope", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ wire: "extension", task: { taskId: "t1" } }),
    );

    await getTask("my-server", "t1");

    expect(lastCall().path).toBe("/api/web/tasks/get");
    expect(lastCall().body).toMatchObject({
      projectId: "project-1",
      serverId: "server-1",
      taskId: "t1",
    });
  });

  it("batches tracked task reads into one hosted request", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ wire: "extension", tasks: [] }),
    );

    await getTasksBatch("my-server", ["a", "b"]);

    expect(lastCall().path).toBe("/api/web/tasks/get-batch");
    expect(lastCall().body.taskIds).toEqual(["a", "b"]);
  });

  it("maps the hosted TASK_NOT_FOUND code onto the typed task-gone error", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ code: "TASK_NOT_FOUND", message: "forgotten" }, 404),
    );

    await expect(getTask("my-server", "t1")).rejects.toBeInstanceOf(
      TaskUnknownOrExpiredError,
    );
  });

  it("keeps a structureless 404 distinguishable from a forgotten task", async () => {
    // An older hosted replica without the task routes: the poller must retry
    // rather than mark the task unavailable.
    authFetchMock.mockResolvedValue(jsonResponse(null, 404));

    const error = await getTask("my-server", "t1").catch((e) => e);
    expect(error).not.toBeInstanceOf(TaskUnknownOrExpiredError);
  });

  it("maps TASK_NOT_FOUND on update too", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ code: "TASK_NOT_FOUND", message: "forgotten" }, 404),
    );

    await expect(
      updateTask("my-server", "t1", { k: {} }),
    ).rejects.toBeInstanceOf(TaskUnknownOrExpiredError);
  });

  it("reads real capabilities hosted instead of reporting no support", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ wire: "legacy", toolCalls: true, list: true }),
    );

    const support = await getTaskCapabilities("my-server");

    expect(lastCall().path).toBe("/api/web/tasks/capabilities");
    expect(support.wire).toBe("legacy");
  });

  it("cancels through the hosted route", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ wire: "extension", task: null }),
    );

    await cancelTask("my-server", "t1");

    expect(lastCall().path).toBe("/api/web/tasks/cancel");
  });

  it("reports no progress hosted without touching the network", async () => {
    await expect(getLatestProgress("my-server")).resolves.toBeNull();
    await expect(getAllProgress("my-server")).resolves.toEqual([]);
    expect(authFetchMock).not.toHaveBeenCalled();
  });
  it("forwards the extension allowTaskResult declaration on hosted tool execution", async () => {
    const { executeToolApi } = await import("../mcp-tools-api");
    authFetchMock.mockResolvedValue(jsonResponse({ status: "completed" }));

    await executeToolApi("my-server", "long_running", {}, undefined, true);

    expect(lastCall().path).toBe("/api/web/tools/execute");
    expect(lastCall().body).toMatchObject({
      toolName: "long_running",
      allowTaskResult: true,
    });
    expect(lastCall().body.taskOptions).toBeUndefined();
  });

  it("keeps tracked task handles across a transient context teardown", async () => {
    const { trackTask, getTrackedTasksForServer } = await import(
      "@/lib/task-tracker"
    );
    trackTask(
      {
        taskId: "t1",
        serverId: "my-server",
        wire: "extension",
        toolName: "long_running",
        createdAt: new Date().toISOString(),
      } as never,
    );
    expect(getTrackedTasksForServer("my-server")).toHaveLength(1);

    // `useApiContext` nulls the context on every dependency change and
    // immediately restores it: that must not look like a logout.
    setApiContext(null);
    setApiContext({
      projectId: "project-1",
      isAuthenticated: true,
      serverIdsByName: { "my-server": "server-1" },
    } as never);

    expect(getTrackedTasksForServer("my-server")).toHaveLength(1);

    // An actual actor change does drop the previous actor's handles.
    setApiContext({
      projectId: "project-2",
      isAuthenticated: true,
      serverIdsByName: { "my-server": "server-1" },
    } as never);

    expect(getTrackedTasksForServer("my-server")).toHaveLength(0);
  });
});
