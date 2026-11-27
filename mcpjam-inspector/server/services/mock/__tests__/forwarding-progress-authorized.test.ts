/**
 * The same forwarded call as forwarding-progress.test.ts, but the real server
 * is opened by `openAuthorizedReal` on a manager `createAuthorizedManager`
 * built, not by a bare manager. That manager is what a hosted door uses, and
 * its card progress handler used to replace the SDK client's own progress
 * dispatch, so no `onprogress` the forward passed ever fired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { MCPClientManager } from "@mcpjam/sdk";
import { openAuthorizedReal } from "../connection.js";
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


const realFetch = global.fetch;
const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://convex.example.com";
  // Only the backend's authorize call is stubbed; the real server is dialed for real.
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/web/authorize-batch")) {
      return new Response(
        JSON.stringify({
          results: {
            real1: {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: { transportType: "http", url: base.url, useOAuth: false },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  global.fetch = realFetch;
  if (originalConvexHttpUrl) process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
  else delete process.env.CONVEX_HTTP_URL;
});

const door: MockDoor = {
  kind: "http",
  bearerToken: "ann",
  caller: { authMethod: "jwt", workosUserId: "ann" },
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
        open: openAuthorizedReal,
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

describe.each(REVISIONS)("a forwarded call through an authorized manager on %s", (revision) => {
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
