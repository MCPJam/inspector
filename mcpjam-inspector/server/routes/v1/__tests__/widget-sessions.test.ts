import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  verify: vi.fn(),
  connect: vi.fn(),
  render: vi.fn(),
  tool: vi.fn(),
  disconnect: vi.fn(),
  dispose: vi.fn(),
  snapshot: vi.fn(),
  action: vi.fn(),
  step: vi.fn(),
  revoked: false,
  localIdentity: vi.fn(),
  localWithoutWorkos: false,
}));
vi.mock("../../../services/plugin-host/admission.js", async (original) => ({
  ...(await original<typeof import("../../../services/plugin-host/admission.js")>()),
  resolvePluginCleanupActor: f.localIdentity,
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({ getConvexBearerForRequest: async () => "verified-by-backend" }));
vi.mock("../../web/auth.js", () => ({
  createManualHostedConnection: f.connect,
}));
vi.mock("../../../utils/widget-render-core.js", async (original) => ({
  ...(await original<typeof import("../../../utils/widget-render-core.js")>()),
  renderWidgetForRequest: f.render,
}));
vi.mock("../../../middleware/require-verified-auth.js", async (original) => {
  const actual = await original<typeof import("../../../middleware/require-verified-auth.js")>();
  return { ...actual, requireVerifiedAuth: () => {
    const middleware = actual.requireVerifiedAuth();
    const wrapped: ReturnType<typeof actual.requireVerifiedAuth> = (c, next) => {
      f.verify();
      return middleware(c, next);
    };
    return wrapped;
  } };
});
import routes from "../widget-sessions.js";
import { widgetRenderSessions } from "../../../services/widget-render-session.js";
import { WebRouteError, ErrorCode } from "../../web/errors.js";

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("authMethod", "workos_api_key");
  if (!f.localWithoutWorkos) c.set("workosUserId", c.req.header("x-test-subject") ?? "user-a");
  await next();
});
app.onError((error) => Response.json(
  { message: error.message },
  { status: error instanceof WebRouteError ? error.status : 500 },
));
app.route("/", routes);
app.get("/unrelated", (c) => c.json({ ok: true }));
const base = "/projects/project-a/servers/server-a/widget-sessions";
const request = (
  url: string,
  method = "GET",
  body?: unknown,
  subject = "user-a",
) =>
  app.request(url, {
    method,
    headers: { "content-type": "application/json", "x-test-subject": subject },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
beforeEach(async () => {
  await widgetRenderSessions.disposeAll();
  vi.clearAllMocks();
  f.revoked = false;
  f.localWithoutWorkos = false;
  f.localIdentity.mockResolvedValue("backend-user");
  f.connect.mockImplementation(async (_c, scope) => {
    if (f.revoked)
      throw new WebRouteError(
        403,
        ErrorCode.FORBIDDEN,
        "Project access revoked",
      );
    return {
      manager: {
        listTools: vi.fn(),
        readResource: vi.fn(),
        executeTool: f.tool,
        disconnectAllServers: f.disconnect,
      },
      body: scope,
    };
  });
  f.disconnect.mockResolvedValue(undefined);
  f.dispose.mockResolvedValue(undefined);
  f.snapshot.mockResolvedValue({
    tree: "viewer",
    mode: "a11y",
    elements: [],
    capturedAt: 1,
  });
  f.tool.mockResolvedValue({ content: [] });
  f.render.mockImplementation(async (options) => {
    const harness = {
      dispose: f.dispose,
      captureSnapshot: f.snapshot,
      executeAction: f.action.mockImplementation(async () => {
        await options.mcpClientManager.executeTool("server-a", "read-view", {});
        return {
          action: { action: "screenshot" },
          widgetToolCalls: [],
          elapsedMs: 1,
        };
      }),
      runScriptedStep: f.step.mockResolvedValue({
        step: { kind: "wait" },
        ok: true,
        widgetToolCalls: [],
        followUps: [],
        elapsedMs: 1,
      }),
    };
    return {
      harness,
      observation: {
        status: "rendered",
        toolCallId: "widget",
        serverId: options.serverId,
        toolName: options.toolName,
        elapsedMs: 1,
        ts: 1,
      },
    };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await widgetRenderSessions.disposeAll();
});
async function start(clientCapabilities?: Record<string, unknown>) {
  const response = await request(base, "POST", {
    toolName: "open",
    ...(clientCapabilities ? { clientCapabilities } : {}),
    projectId: "wrong-project",
    serverId: "wrong-server",
  });
  expect(response.status).toBe(200);
  return (await response.json()).sessionId as string;
}

describe("scoped retained widget HTTP sessions", () => {
  it("binds local sessions to a backend-verified identity when WorkOS is not configured", async () => {
    f.localWithoutWorkos = true;
    const id = await start();
    expect(f.localIdentity).toHaveBeenCalledWith(expect.objectContaining({ bearer: "verified-by-backend" }));
    expect((await request(`${base}/${id}/snapshot`)).status).toBe(200);
    f.localIdentity.mockResolvedValue("different-backend-user");
    expect((await request(`${base}/${id}/snapshot`)).status).toBe(404);
  });
  it.each([
    { route: base, body: { toolName: "open", clientCapabilities: [] } },
    { route: `${base}/unknown/scripted-step`, body: { step: { kind: "invented" } } },
    { route: `${base}/unknown/scripted-step`, body: { step: { kind: "wait", ms: 1 }, priorWidgetToolCalls: "invalid" } },
  ])("answers malformed widget fields with 400: $body", async ({ route, body }) => {
    expect((await request(route, "POST", body)).status).toBe(400);
    expect(f.render).not.toHaveBeenCalled();
    expect(f.step).not.toHaveBeenCalled();
  });
  it("does not apply its verifier to later sibling routes", async () => {
    expect((await request("/unrelated")).status).toBe(200);
    expect(f.verify).not.toHaveBeenCalled();
    await start();
    expect(f.verify).toHaveBeenCalledOnce();
  });
  it("pins URL scope, preserves the viewer, and uses a fresh connection per control", async () => {
    const id = await start();
    expect(f.connect.mock.calls[0][1]).toEqual({
      projectId: "project-a",
      serverId: "server-a",
    });
    expect(widgetRenderSessions.get(id)).toBeUndefined();
    expect((await request(`${base}/${id}/snapshot`)).status).toBe(200);
    expect(
      (
        await request(`${base}/${id}/action`, "POST", {
          action: { action: "screenshot" },
        })
      ).status,
    ).toBe(200);
    expect(f.render).toHaveBeenCalledOnce();
    expect(f.tool).toHaveBeenCalledOnce();
    expect(f.connect).toHaveBeenCalledTimes(3);
    expect(f.disconnect).toHaveBeenCalledTimes(3);
    const options = f.render.mock.calls[0][0];
    expect(() =>
      options.mcpClientManager.executeTool("server-a", "read-view", {}),
    ).toThrow("no active authorized request");
    expect((await request(`${base}/${id}`, "DELETE")).status).toBe(200);
    expect(f.dispose).toHaveBeenCalledOnce();
  });
  it("keeps explicit capabilities identical across reconnects", async () => {
    const clientCapabilities = { experimental: { "test.extension": { supported: true } } };
    const id = await start(clientCapabilities);
    expect((await request(`${base}/${id}/snapshot`)).status).toBe(200);
    expect(f.connect.mock.calls.map((call) => call[1].clientCapabilities)).toEqual([clientCapabilities, clientCapabilities]);
  });
  it("refuses another principal, project or server before connecting or operating", async () => {
    const id = await start();
    for (const [path, subject] of [
      [`${base}/${id}/snapshot`, "user-b"],
      [
        `/projects/project-b/servers/server-a/widget-sessions/${id}/snapshot`,
        "user-a",
      ],
      [
        `/projects/project-a/servers/server-b/widget-sessions/${id}/snapshot`,
        "user-a",
      ],
    ])
      expect((await request(path, "GET", undefined, subject)).status).toBe(404);
    await expect(widgetRenderSessions.close(id)).resolves.toBe(false);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(
      (await request(`${base}/${id}`, "DELETE", undefined, "user-b")).status,
    ).toBe(200);
    expect(f.dispose).not.toHaveBeenCalled();
  });
  it("refuses revoked access but still lets the verified owner clean up", async () => {
    const id = await start();
    f.revoked = true;
    expect((await request(`${base}/${id}/snapshot`)).status).toBe(403);
    expect(f.snapshot).not.toHaveBeenCalled();
    expect((await request(`${base}/${id}`, "DELETE")).status).toBe(200);
    expect(f.dispose).toHaveBeenCalledOnce();
  });
  it("refuses closed sessions without replaying the original tool", async () => {
    const id = await start();
    await request(`${base}/${id}`, "DELETE");
    expect((await request(`${base}/${id}/snapshot`)).status).toBe(404);
    await Promise.resolve();
    expect(f.render).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
  });
});
