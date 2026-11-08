import { Hono } from "hono";
import { z } from "zod";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  colocate: vi.fn(),
  manager: vi.fn(),
  available: true,
}));
vi.mock("../../../config.js", async (original) => ({
  ...(await original<typeof import("../../../config.js")>()),
  HOSTED_MODE: true,
}));
vi.mock("../../../services/plugins/computer-stdio.js", async (original) => ({
  ...(await original<
    typeof import("../../../services/plugins/computer-stdio.js")
  >()),
  canColocatePluginStdio: () => f.available,
}));
vi.mock("../../../services/plugins/hosted-stdio-connect.js", () => ({
  resolvePluginStdioHttpTarget: f.colocate,
}));
vi.mock("@mcpjam/sdk", async (original) => ({
  ...(await original<typeof import("@mcpjam/sdk")>()),
  MCPClientManager: f.manager.mockImplementation(function () {
    return { disconnectAllServers: vi.fn() };
  }),
}));
import { createManualHostedConnection } from "../auth.js";

const schema = z.object({ projectId: z.string(), serverId: z.string() });
let config: Record<string, unknown> | undefined;
let marked = true;
let requestBodies: Record<string, unknown>[];
const app = new Hono();
app.post("/", async (c) => {
  await createManualHostedConnection(c, await c.req.json(), schema, {
    lazyConnect: true,
    hostConfigForBody: async () => config,
  });
  return c.json({ ok: true });
});
app.onError(() => Response.json({ refused: true }, { status: 400 }));
const request = () =>
  app.request("/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer member-jwt",
    },
    body: JSON.stringify({
      projectId: "project",
      serverId: "plugin",
      computer: { kind: "personal" },
      pluginComputerRuntime: true,
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  marked = true;
  f.available = true;
  config = undefined;
  requestBodies = [];
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example");
  f.colocate.mockResolvedValue({
    url: "https://sandbox.example/mcp",
    token: "runtime-token",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(init?.body as string));
      return Response.json({
        results: {
          plugin: {
            ok: true,
            role: "owner",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "stdio",
              ...(marked ? { pluginComponent: true } : {}),
            },
          },
        },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("refuses no host and Computer-off hosts despite forged body claims", async () => {
  expect((await request()).status).toBe(400);
  config = { computer: null };
  expect((await request()).status).toBe(400);
  expect(
    requestBodies.every(
      (body) =>
        body.pluginComputerRuntime === undefined &&
        body.localRuntime === undefined,
    ),
  ).toBe(true);
  expect(f.colocate).not.toHaveBeenCalled();
});

it("uses fresh host Computer opt-in and a backend plugin marker", async () => {
  config = { computer: { kind: "personal" } };
  expect((await request()).status).toBe(200);
  expect(requestBodies[0]).toMatchObject({ pluginComputerRuntime: true });
  expect(requestBodies[0].localRuntime).toBeUndefined();
  expect(f.colocate).toHaveBeenCalledOnce();
  config = { computer: null };
  expect((await request()).status).toBe(400);
  expect(f.colocate).toHaveBeenCalledOnce();
});

it("never colocates an unmarked server or an unconfigured data plane", async () => {
  config = { computer: { kind: "personal" } };
  marked = false;
  expect((await request()).status).toBe(400);
  expect(f.colocate).not.toHaveBeenCalled();
  f.available = false;
  marked = true;
  expect((await request()).status).toBe(400);
  expect(requestBodies.at(-1)?.pluginComputerRuntime).toBeUndefined();
  expect(f.colocate).not.toHaveBeenCalled();
});
