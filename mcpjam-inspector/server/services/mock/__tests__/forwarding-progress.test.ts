/**
 * A forwarded call's progress and log messages reach the caller on every
 * revision, through the route. The real server is an HTTP server whose one tool
 * reports progress and logs a message while it runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({ Authorization: `Bearer ${bearer}` }),
  createAuthorizedManager: vi.fn(),
}));

import { serve } from "@hono/node-server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { MCPClientManager } from "@mcpjam/sdk";
import type { OpenReal } from "../connection.js";
import { serveMock, type MockDoor } from "../route.js";
import { resolvedMock } from "./helpers.js";

type Revision = "2025-03-26" | "2025-06-18" | "2025-11-25" | "2026-07-28";
const REVISIONS: Revision[] = ["2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"];

let base: { url: string; close(): Promise<void> };

function buildBase() {
  const server = new McpServer(
    { name: "progress-base", version: "1.0.0" },
    { capabilities: { tools: {}, logging: {} } },
  );
  server.registerTool("work", { description: "Reports progress and logs.", inputSchema: {} }, async (_args, ctx) => {
    const token = ctx.mcpReq._meta?.progressToken;
    if (token !== undefined) {
      await ctx.mcpReq.notify({
        method: "notifications/progress",
        params: { progressToken: token, progress: 1, total: 2, message: "half" },
      });
    }
    await ctx.mcpReq.log("info", "step one");
    return { content: [{ type: "text" as const, text: "done" }] };
  });
  return server;
}

beforeEach(async () => {
  const handler = createMcpHandler(() => buildBase(), { legacy: "stateless" });
  const http = serve({ fetch: (request) => handler.fetch(request), port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise<void>((r) => http.close(() => r())) };
});
afterEach(async () => {
  await base.close();
});

const open: OpenReal = async () => ({
  manager: new MCPClientManager({}, { lazyConnect: true }),
  config: { url: base.url },
});

const door: MockDoor = {
  kind: "http",
  bearerToken: "ann",
  caller: { authMethod: "workos_api_key", workosUserId: "ann" },
  profile: { timeoutMs: 5_000 },
};

/** A caller pinned to `revision`, calling `work` through the mock and listening for its progress and logs. */
async function callThroughMock(revision: Revision) {
  const manager = new MCPClientManager();
  await manager.connectToServer("mock", {
    url: "https://mock.test/mock1",
    mcpProtocolVersion: revision,
    baseFetch: ((input: string, init?: RequestInit) =>
      serveMock(new Request(input, init), "mock1", door, {
        resolve: async () => resolvedMock({ definition: {}, baseServerId: "real1" }),
        open,
        check: async () => ({ allowed: true }),
      })) as typeof fetch,
  });
  const logs: unknown[] = [];
  manager.addNotificationHandler("mock", "notifications/message", ((n: { params?: { data?: unknown } }) => {
    logs.push(n.params?.data);
  }) as never);
  if (manager.getLoggingMechanism("mock") === "per-request-meta") manager.setPerRequestLogLevel("mock", "info");
  else await manager.setLoggingLevel("mock", "info");
  const progress: Array<{ progress: number; total?: number; message?: string }> = [];
  const result = (await manager.executeTool("mock", "work", {}, { onprogress: (p) => progress.push(p) })) as {
    content: Array<{ text: string }>;
  };
  await manager.disconnectAllServers();
  return { result, progress, logs };
}

describe.each(REVISIONS)("a forwarded call on %s", (revision) => {
  it("relays the real server's progress on the caller's request", async () => {
    const { result, progress } = await callThroughMock(revision);
    expect(result.content[0].text).toBe("done");
    expect(progress).toEqual([expect.objectContaining({ progress: 1, total: 2, message: "half" })]);
  });

  it("relays the real server's log message to the caller", async () => {
    const { logs } = await callThroughMock(revision);
    expect(logs).toEqual(["step one"]);
  });
});
