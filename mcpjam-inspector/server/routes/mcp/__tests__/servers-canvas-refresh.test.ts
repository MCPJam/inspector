import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rollout: vi.fn(),
  refresh: vi.fn(),
  authorize: vi.fn(),
  keys: vi.fn(),
}));

vi.mock("../../../utils/server-canvas-rollout.js", () => ({
  resolveServerCanvasRollout: mocks.rollout,
}));
vi.mock("../../../services/server-canvas/refresh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/server-canvas/refresh.js")>()),
  runCanvasRefresh: mocks.refresh,
}));
vi.mock("../../../utils/local-server-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/local-server-resolver.js")>()),
  authorizeServerLocal: mocks.authorize,
}));
vi.mock("../../../utils/mcp-connections.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/mcp-connections.js")>()),
  localConnectionKeysForServer: mocks.keys,
}));

import { WebRouteError, ErrorCode } from "../../web/errors.js";
import { createMockMcpClientManager } from "./helpers/mock-mcp-client-manager.js";
import { createTestApp } from "./helpers/test-app.js";

const manager = createMockMcpClientManager();
const app = createTestApp(manager, "servers");

function refresh(body: unknown, bearer: string | null = "user-token") {
  return app.request("/api/mcp/servers/canvas/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const BODY = { projectId: "prj_1", serverId: "srv_1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rollout.mockResolvedValue(true);
  mocks.authorize.mockResolvedValue({ oauthCredentialId: "cred_1" });
  mocks.keys.mockReturnValue(["Fixture"]);
  mocks.refresh.mockResolvedValue({ outcome: "started", done: Promise.resolve() });
});

describe("POST /api/mcp/servers/canvas/refresh", () => {
  it("queues a refresh on the existing connection and answers 202", async () => {
    const response = await refresh(BODY);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(mocks.authorize).toHaveBeenCalledWith(
      expect.anything(),
      "user-token",
      "prj_1",
      "srv_1",
    );
    expect(mocks.refresh).toHaveBeenCalledWith({
      hosted: false,
      projectId: "prj_1",
      serverId: "srv_1",
      manager,
      managerKey: "Fixture",
      convexBearer: "user-token",
      accountKey: "cred_1",
    });
  });

  it("joins a refresh already running for the server instead of starting another", async () => {
    let finish: () => void = () => undefined;
    mocks.refresh.mockResolvedValueOnce({
      outcome: "started",
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    });
    expect((await refresh(BODY)).status).toBe(202);
    const joined = await refresh(BODY);
    expect(joined.status).toBe(202);
    expect(await joined.json()).toEqual({ status: "accepted" });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(async () => {
      expect((await refresh(BODY)).status).toBe(202);
      expect(mocks.refresh).toHaveBeenCalledTimes(2);
    });
  });

  it("answers 409 disabled, and does nothing, when the rollout is off", async () => {
    mocks.rollout.mockResolvedValue(false);
    const response = await refresh(BODY);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "disabled" });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("answers 409 not-connected when the server has no live connection", async () => {
    mocks.keys.mockReturnValue([]);
    const response = await refresh(BODY);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "not-connected" });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("passes authorization refusals through the local error envelope", async () => {
    mocks.authorize.mockRejectedValue(
      new WebRouteError(403, ErrorCode.FORBIDDEN, "You do not have access to this server."),
    );
    const response = await refresh(BODY);
    expect(response.status).toBe(403);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("requires a bearer and both ids", async () => {
    expect((await refresh(BODY, null)).status).toBe(401);
    expect((await refresh({ projectId: "prj_1" })).status).toBe(400);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
