/**
 * The registry caller against a backend that is off, undeployed, or broken.
 *
 * Everything here is about degradation, because the feature ships dark: until
 * the backend's owner-binding gate is switched on, EVERY call takes one of
 * these paths. "The turn completes and the tool call is unaffected" is the
 * whole contract at that point.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskCreatedEvent } from "@mcpjam/sdk";

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../internal-backend.js", async () => {
  const actual = await vi.importActual<
    typeof import("../internal-backend.js")
  >("../internal-backend.js");
  return {
    ...actual,
    getInternalBackendConfig: () => ({
      convexUrl: "https://backend.test",
      serviceToken: "svc-token",
    }),
  };
});

import {
  deleteRegistryTask,
  listRegistryTasks,
  recordCreatedTask,
  recordHostedTask,
  reportTaskStatuses,
} from "../hosted-task-registry.js";
import { logger } from "../../utils/logger.js";

const event: TaskCreatedEvent = {
  identity: { serverId: "srv_1", wire: "extension", taskId: "task-1" },
  wire: "extension",
  surface: "chat",
  status: "working",
  createdAt: "2026-07-28T10:00:00.000Z",
};

const options = { bearer: "user-jwt", projectId: "proj_1" };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("recordHostedTask", () => {
  it("sends both credentials", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await recordHostedTask(event, options);

    const [, init] = fetchMock.mock.calls[0];
    // The service token proves the inspector is calling; the bearer proves who
    // for. Dropping either one is a security regression, not a cosmetic change.
    expect(init.headers["x-inspector-service-token"]).toBe("svc-token");
    expect(init.headers.authorization).toBe("Bearer user-jwt");
  });

  it("never sends the server-derived identity fields", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await recordHostedTask(event, options);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // The backend REJECTS these rather than ignoring them, so sending one is a
    // hard 400 — but the point of asserting here is that a future edit adding
    // one back gets caught before it reaches a deployed backend.
    expect(body).not.toHaveProperty("ownerUserId");
    expect(body).not.toHaveProperty("authContextKey");
    expect(body.projectId).toBe("proj_1");
    expect(body.taskId).toBe("task-1");
    expect(body.wire).toBe("extension");
  });

  it("treats a gated-off backend as info, not an incident", async () => {
    // Gate-off and not-deployed share this envelope deliberately.
    fetchMock.mockResolvedValue(
      jsonResponse(404, { ok: false, error: "Not found" }),
    );

    await expect(recordHostedTask(event, options)).resolves.toBe(false);
    expect(logger.info).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("throws a typed error for a routing 404 with no envelope", async () => {
    // No `{ok:false}` body means the request never reached the route at all.
    fetchMock.mockResolvedValue(jsonResponse(404, { message: "not found" }));

    await expect(recordHostedTask(event, options)).rejects.toThrow(
      /is the backend route deployed/i,
    );
  });

  it("warns on 401 — both credentials are required", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { ok: false, error: "Unauthorized" }),
    );

    await expect(recordHostedTask(event, options)).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("does not bind to a turn abort signal", async () => {
    // A user who hits Stop is exactly the user who needs the recovery row.
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await recordHostedTask(event, options);

    const signal: AbortSignal = fetchMock.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
  });

  it("reports a plain failure without throwing", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { ok: false }));
    await expect(recordHostedTask(event, options)).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});

const scope = { bearer: "user-jwt", projectId: "proj_1", serverId: "srv_1" };

const entry = {
  wire: "extension" as const,
  taskId: "task-9",
  lastKnownStatus: "working" as const,
  createdAt: 1_000,
  updatedAt: 2_000,
  lastObservedAt: 2_000,
};

describe("recordCreatedTask", () => {
  it("writes the same upsert body as the sink path, defaulting the status", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

    await expect(
      recordCreatedTask(scope, {
        wire: "legacy",
        taskId: "task-7",
        createdAt: 1_753_000_000_000,
      }),
    ).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/internal/v1/hosted-tasks/upsert");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      projectId: "proj_1",
      serverId: "srv_1",
      wire: "legacy",
      taskId: "task-7",
      lastKnownStatus: "working",
      createdAt: 1_753_000_000_000,
    });
    expect(body).not.toHaveProperty("ownerUserId");
    expect(body).not.toHaveProperty("authContextKey");
  });
});

describe("listRegistryTasks", () => {
  it("returns the entries the backend answered with", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, tasks: [entry] }));

    await expect(listRegistryTasks(scope)).resolves.toEqual([entry]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/internal/v1/hosted-tasks/list");
    expect(init.headers["x-inspector-service-token"]).toBe("svc-token");
    expect(init.headers.authorization).toBe("Bearer user-jwt");
    expect(JSON.parse(init.body)).toEqual({
      projectId: "proj_1",
      serverId: "srv_1",
    });
  });

  it("returns [] only for a VERIFIED empty registry", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, tasks: [] }));
    await expect(listRegistryTasks(scope)).resolves.toEqual([]);
  });

  it("returns null — never [] — on an outage", async () => {
    // An outage reported as "verified empty" would tell the caller to stop
    // tracking handles that are still running.
    fetchMock.mockResolvedValue(
      jsonResponse(503, { ok: false, degraded: true, error: "unavailable" }),
    );
    await expect(listRegistryTasks(scope)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("treats the disabled envelope as info, not an incident", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { ok: false, error: "Not found" }),
    );
    await expect(listRegistryTasks(scope)).resolves.toBeNull();
    expect(logger.info).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns null with a warn on 401", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { ok: false, error: "Unauthorized" }),
    );
    await expect(listRegistryTasks(scope)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns null when the fetch itself fails (network/deadline)", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(listRegistryTasks(scope)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("still throws on a routing 404 with no envelope (deployment error)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: "not found" }));
    await expect(listRegistryTasks(scope)).rejects.toThrow(
      /is the backend route deployed/i,
    );
  });
});

describe("reportTaskStatuses", () => {
  it("sends no request at all for an empty batch", async () => {
    await reportTaskStatuses(scope, []);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stamps observed: true on every update", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ok: true, patched: 2, unknown: 0 }),
    );

    await reportTaskStatuses(scope, [
      { wire: "extension", taskId: "a", status: "working" },
      { wire: "extension", taskId: "b", status: "expired" },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/internal/v1/hosted-tasks/report",
    );
    expect(body.updates).toEqual([
      { wire: "extension", taskId: "a", lastKnownStatus: "working", observed: true },
      { wire: "extension", taskId: "b", lastKnownStatus: "expired", observed: true },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("treats the backend's degraded envelope as success", async () => {
    // `{ ok: true, degraded: true }` is the write routes' whole contract:
    // the poll that produced these observations already succeeded.
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ok: true, degraded: true, patched: 0, unknown: 1 }),
    );
    await reportTaskStatuses(scope, [
      { wire: "legacy", taskId: "a", status: "completed" },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("never throws — one warn per failed batch", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { ok: false }));
    await expect(
      reportTaskStatuses(scope, [
        { wire: "legacy", taskId: "a", status: "completed" },
      ]),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("absorbs even the routing-404 throw (fire-and-forget safe)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: "not found" }));
    await expect(
      reportTaskStatuses(scope, [
        { wire: "legacy", taskId: "a", status: "completed" },
      ]),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("deleteRegistryTask", () => {
  // NOTE: implemented + tested with NO production caller in v1 — dismissal
  // stays local; global "remove everywhere" is deferred per the master plan.
  const task = { wire: "extension" as const, taskId: "task-9" };

  it("returns true only when the backend confirmed the removal", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, deleted: true }));
    await expect(deleteRegistryTask(scope, task)).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/internal/v1/hosted-tasks/delete",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      projectId: "proj_1",
      serverId: "srv_1",
      wire: "extension",
      taskId: "task-9",
    });
  });

  it("returns false on the 503 outage envelope — never a fake success", async () => {
    // A degraded "deleted" is a lie the user acts on: the row survives and
    // the handle reappears on the next recovery read.
    fetchMock.mockResolvedValue(
      jsonResponse(503, { ok: false, degraded: true, error: "unavailable" }),
    );
    await expect(deleteRegistryTask(scope, task)).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns false as info when the registry is disabled", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { ok: false, error: "Not found" }),
    );
    await expect(deleteRegistryTask(scope, task)).resolves.toBe(false);
    expect(logger.info).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
