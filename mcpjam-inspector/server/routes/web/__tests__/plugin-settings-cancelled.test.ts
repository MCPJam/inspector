import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ report: vi.fn(), catalog: vi.fn() }));
vi.mock("../../../utils/route-error-report.js", () => ({ reportRouteFailure: f.report }));
vi.mock("../../../utils/analytics.js", () => ({ captureServerEvent: vi.fn() }));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "fixture-bearer",
}));
vi.mock("../../../utils/tool-approval-token.js", () => ({
  toolApprovalSubjectFromAuthHeader: () => "verified-subject",
}));
vi.mock("../../../services/plugin-host/admission.js", async (original) => ({
  ...(await original<typeof import("../../../services/plugin-host/admission.js")>()),
  admitPluginWorkspace: async () => ({
    actorId: "actor", projectId: "project", workspaceId: "workspace",
    revalidate: async () => {},
  }),
}));
vi.mock("../../../services/plugin-host/request-runtime.js", async (original) => ({
  ...(await original<typeof import("../../../services/plugin-host/request-runtime.js")>()),
  createPluginRequestRuntime: () => ({ catalog: f.catalog, release: async () => {} }),
}));
import routes from "../plugin-settings";

const app = new Hono().route("/settings", routes);
afterEach(() => vi.clearAllMocks());

/** The shape the SDK's retry helper raises for a string abort reason. */
function abortError(message: string) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function discover(signal: AbortSignal) {
  return app.request("/settings/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: "project",
      pluginWorkspace: { version: 1, workspaceId: "workspace" },
      hostId: "host",
      serverId: "server",
    }),
    signal,
  });
}

it("answers a client cancellation mid-connect as cancelled without reporting it", async () => {
  const client = new AbortController();
  f.catalog.mockImplementation(async () => {
    client.abort("Client connection prematurely closed.");
    throw abortError("Client connection prematurely closed.");
  });
  const response = await discover(client.signal);
  expect(response.status).toBe(408);
  expect(await response.json()).toMatchObject({ code: "PLUGIN_INSTANCE_CANCELLED" });
  expect(f.report).not.toHaveBeenCalled();
});

it("still reports an abort MCPJam raised while the client was waiting", async () => {
  const error = abortError('MCP server "server" was disconnected.');
  f.catalog.mockRejectedValue(error);
  const response = await discover(new AbortController().signal);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "SETTINGS_UNAVAILABLE" });
  expect(f.report).toHaveBeenCalledExactlyOnceWith(
    "Plugin Settings request failed", error, { source: "web.pluginSettings", hop: "mcpjam_internal" },
  );
});
