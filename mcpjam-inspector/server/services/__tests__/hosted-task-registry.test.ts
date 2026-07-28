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

import { recordHostedTask } from "../hosted-task-registry.js";
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
