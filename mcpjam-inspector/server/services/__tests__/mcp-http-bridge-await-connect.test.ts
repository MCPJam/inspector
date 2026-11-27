/**
 * `awaitConnect`: a manager built for one request is still connecting when
 * the request reaches the bridge. The hosted harness proxy builds one per
 * request, so without the wait a fresh turn's handshake was answered before
 * the server's connection existed.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MCPClientManager } from "@mcpjam/sdk";
import { handleJsonRpc } from "../mcp-http-bridge";

const INSTRUCTIONS = "Call echo with the user's words.";

async function modernServer() {
  const handler = createMcpHandler(() => {
    const mcp = new McpServer(
      { name: "await-connect-fixture", version: "1" },
      {
        capabilities: { tools: { listChanged: true } },
        instructions: INSTRUCTIONS,
      },
    );
    mcp.registerTool("echo", {}, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    return mcp;
  });
  const server = http.createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A port nothing listens on, so the connect fails at once. */
async function closedUrl() {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${address.port}/mcp`;
}

const discover = {
  jsonrpc: "2.0",
  id: 1,
  method: "server/discover",
  params: {},
};
const initialize = {
  jsonrpc: "2.0",
  id: 2,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "harness", version: "1" },
  },
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A manager built the way the harness proxy builds one: connect queued, not awaited. */
function freshManager(url: string) {
  const manager = new MCPClientManager({ srv: { url, timeout: 5_000 } });
  cleanups.push(() => manager.disconnectAllServers());
  return manager;
}

describe("handleJsonRpc with awaitConnect", () => {
  it("answers server/discover from the server once its connect finishes", async () => {
    const served = await modernServer();
    cleanups.push(served.close);
    const response = await handleJsonRpc(
      "srv",
      discover,
      freshManager(served.url),
      "adapter",
      { awaitConnect: true },
    );
    expect(response.error).toBeUndefined();
    expect(response.result.supportedVersions).toContain("2026-07-28");
  });

  it("answers initialize with the server's own instructions and capabilities", async () => {
    const served = await modernServer();
    cleanups.push(served.close);
    const response = await handleJsonRpc(
      "srv",
      initialize,
      freshManager(served.url),
      "adapter",
      { awaitConnect: true },
    );
    expect(response.result).toMatchObject({
      instructions: INSTRUCTIONS,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "await-connect-fixture" },
    });
  });

  it("is what stands between a fresh manager and method-not-found", async () => {
    const served = await modernServer();
    cleanups.push(served.close);
    const response = await handleJsonRpc(
      "srv",
      discover,
      freshManager(served.url),
      "adapter",
    );
    expect(response.error).toMatchObject({ code: -32601 });
  });

  it("answers as before when the connect fails", async () => {
    const manager = freshManager(await closedUrl());
    const discovered = await handleJsonRpc("srv", discover, manager, "adapter", {
      awaitConnect: true,
    });
    expect(discovered.error).toMatchObject({ code: -32601 });
    const initialized = await handleJsonRpc(
      "srv",
      initialize,
      manager,
      "adapter",
      { awaitConnect: true },
    );
    expect(initialized.result.protocolVersion).toBe("2025-11-25");
    expect(initialized.result.instructions).toBeUndefined();
  });
});
