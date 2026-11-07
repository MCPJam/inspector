import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { z } from "zod";

const { resolveRuntime } = vi.hoisted(() => ({
  resolveRuntime: vi.fn(async () => ({
    url: "https://plugin.test/mcp",
    token: "disposable-fixture-token",
  })),
}));
vi.mock("../../../services/plugins/computer-stdio.js", () => ({
  canColocatePluginStdio: () => true,
}));
vi.mock("../../../services/plugins/hosted-stdio-connect.js", () => ({
  resolvePluginStdioHttpTarget: resolveRuntime,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      expect(String(input)).toBe("https://backend.test/web/authorize-batch");
      return Response.json({
        isAnonymous: false,
        results: {
          plugin: {
            ok: true,
            role: "member",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: { transportType: "stdio", pluginComponent: true },
          },
        },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const placements = [
  { placement: false, computer: { kind: "personal" }, admitted: false },
  { placement: undefined, computer: { kind: "personal" }, admitted: true },
  { placement: true, computer: null, admitted: false },
] as const;
it.each(
  placements.flatMap((placement) => [
    { ...placement, helper: "manual" },
    { ...placement, helper: "wrapper" },
  ]),
)(
  "gates durable plugin placement: $helper / $placement / $admitted",
  async ({ placement, computer, admitted, helper }) => {
    const { createManualHostedConnection, withEphemeralConnection } =
      await import("../auth.js");
    const app = new Hono();
    app.post("/", async (c) => {
      try {
        if (helper === "wrapper") {
          return await withEphemeralConnection(
            c,
            z.object({ projectId: z.string(), serverIds: z.array(z.string()) }),
            async () => ({ admitted: true }),
            {
              rpcLogs: false,
              pluginComputerRuntime: placement,
              hostConfigForBody: async () => ({ computer }),
            },
          );
        }
        const connection = await createManualHostedConnection(
          c,
          { projectId: "project", serverIds: ["plugin"] },
          z.object({ projectId: z.string(), serverIds: z.array(z.string()) }),
          {
            lazyConnect: true,
            pluginComputerRuntime: placement,
            hostConfig: { computer },
          },
        );
        await connection.manager.disconnectAllServers();
        return c.json({ admitted: true });
      } catch (error) {
        const { WebRouteError } = await import("../errors.js");
        if (!(error instanceof WebRouteError)) throw error;
        return c.json({ code: error.code }, error.status);
      }
    });
    const response = await app.request("/", {
      method: "POST",
      headers: {
        Authorization: "Bearer disposable-fixture-bearer",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectId: "project", serverIds: ["plugin"] }),
    });
    expect(response.status).toBe(admitted ? 200 : 400);
    expect(resolveRuntime).toHaveBeenCalledTimes(admitted ? 1 : 0);
    if (!admitted)
      expect(await response.json()).toMatchObject({
        code: "FEATURE_NOT_SUPPORTED",
      });
  },
);
