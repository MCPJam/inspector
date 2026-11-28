import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  rollout: vi.fn(),
  refresh: vi.fn(),
  disconnect: vi.fn(),
  authorize: vi.fn(),
  managers: [] as unknown[],
}));

vi.mock("../../../utils/server-canvas-rollout.js", () => ({
  resolveServerCanvasRollout: mocks.rollout,
}));
vi.mock("../../../services/server-canvas/refresh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/server-canvas/refresh.js")>()),
  runCanvasRefresh: mocks.refresh,
}));
// The route connects through the real `runEphemeralConnection`; only the
// manager it builds is a stand-in.
vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  class StandInManager {
    constructor() {
      mocks.managers.push(this);
    }
    getServerConfig() {
      return { url: "https://srv.example.com/mcp" };
    }
    disconnectAllServers() {
      return mocks.disconnect();
    }
  }
  return { ...actual, MCPClientManager: StandInManager };
});

const { default: serversRoute } = await import("../servers.js");
const { serverCheckScope } = await import("../../../utils/server-check-scope.js");

function authorized(): Response {
  return new Response(
    JSON.stringify({
      results: {
        srv_1: {
          ok: true,
          role: "member",
          accessLevel: "project_member",
          permissions: { chatOnly: false },
          serverConfig: { transportType: "http", url: "https://srv.example.com/mcp" },
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function refused(): Response {
  return new Response(
    JSON.stringify({ code: "FORBIDDEN", message: "You do not have access to this server." }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}

/** The route behind a stand-in for the bearer middleware's verified principal. */
async function refresh(body: unknown, caller?: string): Promise<Response> {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (caller) c.set("workosUserId", caller);
    await next();
  });
  app.route("/", serversRoute);
  return app.request("/canvas/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-token" },
    body: JSON.stringify(body),
  });
}

function pendingRun() {
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { run: { outcome: "started", done }, finish };
}

const BODY = { projectId: "prj_1", serverId: "srv_1" };
const originalFetch = global.fetch;
const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.managers.length = 0;
  process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  mocks.authorize.mockImplementation(async () => authorized());
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/web/authorize-batch")) return mocks.authorize();
    throw new Error(`Unexpected fetch: ${String(input)}`);
  }) as typeof fetch;
  mocks.rollout.mockResolvedValue(true);
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue({ outcome: "started", done: Promise.resolve() });
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalConvexHttpUrl === undefined) delete process.env.CONVEX_HTTP_URL;
  else process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
});

describe("POST /api/web/servers/canvas/refresh", () => {
  it("opens an ephemeral connection, runs the refresh and closes it after", async () => {
    const response = await refresh(BODY, "user_a");
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(mocks.managers).toHaveLength(1);
    expect(mocks.refresh).toHaveBeenCalledWith({
      hosted: true,
      projectId: "prj_1",
      serverId: "srv_1",
      manager: mocks.managers[0],
      managerKey: "srv_1",
      convexBearer: "Bearer user-token",
    });
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });

  it("closes the connection when the probes release it, and answers once they are stored", async () => {
    const first = pendingRun();
    mocks.refresh.mockResolvedValueOnce(first.run);
    let answered = false;
    const pending = refresh(BODY, "user_a").then((response) => {
      answered = true;
      return response;
    });
    await vi.waitFor(() => expect(mocks.disconnect).toHaveBeenCalledTimes(1));
    // Still holding the request, and with it the server-check slot.
    expect(answered).toBe(false);

    // A second refresh from the same caller is authorized, then joins this one.
    const joined = await refresh(BODY, "user_a");
    expect(joined.status).toBe(202);
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.disconnect).toHaveBeenCalledTimes(2);

    first.finish();
    expect((await pending).status).toBe(202);
    expect((await refresh(BODY, "user_a")).status).toBe(202);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not let a caller the server refuses join a running refresh", async () => {
    const first = pendingRun();
    mocks.refresh.mockResolvedValueOnce(first.run);
    const pending = refresh(BODY, "user_a");
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));

    mocks.authorize.mockImplementationOnce(async () => refused());
    const second = await refresh(BODY, "user_a");
    expect(second.status).toBe(403);

    first.finish();
    expect((await pending).status).toBe(202);
  });

  it("runs every refresh from callers without a verified principal", async () => {
    const first = pendingRun();
    mocks.refresh.mockResolvedValueOnce(first.run);
    const pending = refresh(BODY);
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));

    // An unverified passthrough bearer names no one, so nothing is shared.
    expect((await refresh(BODY)).status).toBe(202);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);

    first.finish();
    expect((await pending).status).toBe(202);
  });

  it("closes the connection as soon as the server-check scope aborts", async () => {
    let finishCapture: (run: unknown) => void = () => undefined;
    mocks.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCapture = resolve;
        }),
    );
    const scope = new AbortController();
    const pending = serverCheckScope.run(scope.signal, () => refresh(BODY, "user_a"));
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.disconnect).not.toHaveBeenCalled();

    scope.abort(new Error("preempted"));
    // Closed while the capture is still running, not when it returns.
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);

    finishCapture({ outcome: "failed", done: Promise.resolve() });
    await pending;
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });

  it("answers 409 disabled without connecting when the rollout is off", async () => {
    mocks.rollout.mockResolvedValue(false);
    const response = await refresh(BODY, "user_a");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "disabled" });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("answers 409 disabled when the refresh finds the rollout off", async () => {
    mocks.refresh.mockResolvedValue({ outcome: "rollout-off", done: Promise.resolve() });
    const response = await refresh(BODY, "user_a");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "disabled" });
  });

  it("reports a failed refresh through the web error envelope", async () => {
    mocks.refresh.mockResolvedValue({ outcome: "failed", done: Promise.resolve() });
    const response = await refresh(BODY, "user_a");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "The refresh failed. Try again in a moment.",
    });
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });

  it("reports an authorization refusal through the web error envelope", async () => {
    mocks.authorize.mockImplementation(async () => refused());
    const response = await refresh(BODY, "user_a");
    expect(response.status).toBe(403);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("rejects a body without ids", async () => {
    expect((await refresh({ projectId: "prj_1" }, "user_a")).status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
