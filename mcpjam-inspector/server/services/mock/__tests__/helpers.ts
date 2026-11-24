/**
 * A real MCP server in process, and the pieces that put a mock in front of it
 * the way the route does: a manager that connects to the real server through
 * a fetch that stamps the credential it was opened with, and a dialer that
 * reaches the mock the way MCPJam's own dialers do.
 */
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { MCPClientManager } from "@mcpjam/sdk";
import { z } from "zod";
import type { OpenReal } from "../connection.js";
import type { ResolvedMock } from "../backend.js";

export interface StubReal {
  /** One entry per request the real server received: the credential it carried. */
  credentials: string[];
  /** The `message` of each echo call, in order. */
  echoes: string[];
  /** How many connections were opened to it (calls to `open`). */
  opens: number;
  open: OpenReal;
  /** Remove a tool from the real server, as a redeploy would. */
  hideTools: Set<string>;
}

export function stubRealServer(): StubReal {
  const stub: StubReal = {
    credentials: [],
    echoes: [],
    opens: 0,
    hideTools: new Set(),
    open: async ({ caller, bearerToken, resolved }) => {
      stub.opens += 1;
      const credential = `${caller.workosUserId ?? "anon"}:${bearerToken}`;
      const manager = new MCPClientManager({}, { lazyConnect: true });
      const config = {
        url: "http://real.test/mcp",
        baseFetch: ((input: string, init?: RequestInit) => {
          stub.credentials.push(credential);
          return handler.fetch(new Request(input, init));
        }) as typeof fetch,
      };
      return { manager, config, identity: { id: resolved.baseServerId } };
    },
  };
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "real-stub", version: "1.2.3" },
        { capabilities: { tools: {} } },
      );
      const echo = server.registerTool(
        "echo",
        { description: "Echoes the message.", inputSchema: { message: z.string() } },
        async ({ message }) => {
          stub.echoes.push(String(message));
          return { content: [{ type: "text" as const, text: `echo: ${message}` }] };
        },
      );
      const other = server.registerTool(
        "other",
        { description: "Another tool.", inputSchema: {} },
        async () => ({ content: [{ type: "text" as const, text: "other" }] }),
      );
      if (stub.hideTools.has("echo")) echo.disable();
      if (stub.hideTools.has("other")) other.disable();
      return server;
    },
    { legacy: "stateless" },
  );
  return stub;
}

export function resolvedMock(overrides: Partial<ResolvedMock> = {}): ResolvedMock {
  return {
    mockId: "mock1",
    projectId: "proj1",
    name: "Echo mock",
    version: 2,
    headVersion: 2,
    contentHash: "a".repeat(64),
    definition: { tools: { echo: { description: "MOCKED echo" } } },
    baseServerId: "real1",
    ...overrides,
  };
}

/** Connects a client to whatever `serve` answers, as a dialer's `baseFetch` does. */
export async function dialMock(
  serve: (request: Request) => Promise<Response>,
): Promise<MCPClientManager> {
  const manager = new MCPClientManager();
  await manager.connectToServer("mock", {
    url: "https://mock.mcpjam.invalid/mock1",
    baseFetch: (input, init) => serve(new Request(input as string, init)),
  });
  return manager;
}
