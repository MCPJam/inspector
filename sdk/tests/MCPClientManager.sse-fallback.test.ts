import http from "http";
import type { AddressInfo } from "net";
import { afterEach, describe, expect, it } from "vitest";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MCPAuthError, MCPClientManager } from "../src/mcp-client-manager";
import { createMockServer, startMockStreamableHttpServer } from "./mock-servers";

/**
 * `disableSseFallback` (Agent Plugins Phase 3): a server whose transport was
 * DECLARED streamable-http must never silently downgrade to SSE. The flag is
 * strictly opt-in — the first test pins today's fallback behavior unchanged.
 *
 * The mock speaks SSE only, on a path that does NOT end in `/sse` so the
 * URL heuristic keeps Streamable HTTP as the first attempt: GET /mcp opens
 * the SSE stream, POST /mcp (the Streamable HTTP initialize) is rejected.
 */
async function startSseOnlyServerOnPlainPath(): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const mcpServer = createMockServer();
  let sseTransport: InstanceType<typeof SSEServerTransport> | null = null;

  const httpServer = http.createServer(async (req, res) => {
    if (req.url === "/mcp" && req.method === "GET") {
      sseTransport = new SSEServerTransport("/message", res);
      await mcpServer.connect(sseTransport);
      return;
    }
    if (req.url?.startsWith("/message") && req.method === "POST") {
      const activeTransport = sseTransport;
      if (!activeTransport) {
        res.writeHead(400);
        res.end("No SSE connection established");
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        try {
          await activeTransport.handlePostMessage(req, res, body);
        } catch (error) {
          res.writeHead(500);
          res.end(String(error));
        }
      });
      return;
    }
    // Streamable HTTP's POST /mcp lands here.
    res.writeHead(405);
    res.end("SSE only");
  });

  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}/mcp`,
        stop: () =>
          new Promise<void>((resolveStop) => {
            httpServer.close(() => resolveStop());
          }),
      });
    });
  });
}

/**
 * A genuine Streamable HTTP server served at a `/sse` PATH — the shape that
 * makes the URL heuristic disagree with the declaration.
 */
async function startStreamableServerOnSsePath(): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const mcpServer = createMockServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => `session-${Math.random()}`,
  });
  await mcpServer.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    if (req.url === "/sse") {
      await transport.handleRequest(req, res);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}/sse`,
        stop: () =>
          new Promise<void>((resolveStop) => {
            httpServer.close(() => resolveStop());
          }),
      });
    });
  });
}

/** Every request (both transports) answers 401 — the auth-classification case. */
async function startAlways401Server(): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(401, { "WWW-Authenticate": "Bearer" });
    res.end("Unauthorized");
  });
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}/mcp`,
        stop: () =>
          new Promise<void>((resolveStop) => {
            httpServer.close(() => resolveStop());
          }),
      });
    });
  });
}

describe("MCPClientManager disableSseFallback", () => {
  const managers: MCPClientManager[] = [];
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(managers.map((manager) => manager.disconnectAllServers()));
    managers.length = 0;
    await Promise.all(stops.map((stop) => stop()));
    stops.length = 0;
  });

  it("without the flag, an SSE-only server still connects via the fallback", async () => {
    const server = await startSseOnlyServerOnPlainPath();
    stops.push(server.stop);
    const manager = new MCPClientManager();
    managers.push(manager);

    await manager.connectToServer("sse-only", { url: server.url });
    expect(manager.getConnectionStatus("sse-only")).toBe("connected");
  }, 15000);

  it("with the flag, the Streamable HTTP failure surfaces instead of downgrading", async () => {
    const server = await startSseOnlyServerOnPlainPath();
    stops.push(server.stop);
    const manager = new MCPClientManager();
    managers.push(manager);

    await expect(
      manager.connectToServer("declared-streamable", {
        url: server.url,
        disableSseFallback: true,
      })
    ).rejects.toThrow(/Streamable HTTP.*SSE fallback/s);
    expect(manager.getConnectionStatus("declared-streamable")).not.toBe(
      "connected"
    );
  }, 15000);

  it("with the flag, a working Streamable HTTP server connects unchanged", async () => {
    const server = await startMockStreamableHttpServer();
    stops.push(server.stop);
    const manager = new MCPClientManager();
    managers.push(manager);

    await manager.connectToServer("streamable", {
      url: server.url,
      disableSseFallback: true,
    });
    expect(manager.getConnectionStatus("streamable")).toBe("connected");
  }, 15000);

  it("keeps the MCPAuthError classification hosts key OAuth escalation on", async () => {
    const server = await startAlways401Server();
    stops.push(server.stop);
    const manager = new MCPClientManager();
    managers.push(manager);

    await expect(
      manager.connectToServer("auth-required", {
        url: server.url,
        disableSseFallback: true,
      })
    ).rejects.toThrow(MCPAuthError);
  }, 15000);

  it("reports streamable-http when preferSSE is pinned false on a /sse URL", async () => {
    // The declared-streamable mapping sends `preferSSE: false` precisely so
    // the `/sse` URL heuristic cannot claim the connection. The REPORTED
    // transport must agree with the one actually used, or snapshots and
    // hosted trace metadata record a transport that never ran.
    const server = await startStreamableServerOnSsePath();
    stops.push(server.stop);
    const manager = new MCPClientManager();
    managers.push(manager);

    await manager.connectToServer("declared-on-sse-path", {
      url: server.url,
      preferSSE: false,
      disableSseFallback: true,
    });
    expect(manager.getConnectionStatus("declared-on-sse-path")).toBe(
      "connected"
    );
    const info = manager.getInitializationInfo("declared-on-sse-path");
    expect(info?.transport).toBe("streamable-http");
  }, 15000);

  it("reports sse when the connection actually fell back to SSE", async () => {
    // The mirror case: config says Streamable HTTP first, but the server is
    // SSE-only and the fallback is allowed. Reporting the CONFIG here would
    // record the transport that failed.
    const server = await startSseOnlyServerOnPlainPath();
    stops.push(server.stop);
    const manager = new MCPClientManager();
    managers.push(manager);

    await manager.connectToServer("fell-back", { url: server.url });
    expect(manager.getConnectionStatus("fell-back")).toBe("connected");
    const info = manager.getInitializationInfo("fell-back");
    expect(info?.transport).toBe("sse");
  }, 15000);
});

