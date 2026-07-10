/**
 * Connect-time auto-detection tests for `mcpProtocolVersion: "auto"`.
 *
 * The contract under test: with the `"auto"` pin, the manager probes the
 * server with `server/discover` (2026-07-28 stateless RC). When the probe
 * succeeds it keeps the stateless preview client; when the server answers
 * like a pre-RC stateful server (unknown method, session-required 400,
 * etc.) it falls back to the legacy upstream Client + initialize
 * handshake. Either way the connection comes up without the user setting
 * a per-server override — that's the whole point of "auto".
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import { MCPClientManager } from "../src/mcp-client-manager";
import { startMockStreamableHttpServer, MOCK_TOOLS } from "./mock-servers";

interface StatelessCapturedRequest {
  method: string;
  headers: Record<string, string>;
}

/**
 * Minimal 2026-07-28 stateless fixture: answers `server/discover` and
 * `tools/list` over plain JSON POST, records every JSON-RPC method +
 * headers it sees so tests can assert the wire mode that actually ran.
 */
async function startStatelessFixture(): Promise<{
  url: string;
  close: () => Promise<void>;
  captured: StatelessCapturedRequest[];
}> {
  const captured: StatelessCapturedRequest[] = [];
  const server: Server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
        id: number | string;
        method: string;
      };
      captured.push({
        method: body.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(",") : v ?? "",
          ])
        ),
      });
      const respond = (payload: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (body.method === "server/discover") {
        respond({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            resultType: "complete",
            serverInfo: { name: "stateless-fixture", version: "1.0.0" },
            capabilities: { tools: {} },
            supportedVersions: ["2026-07-28"],
            instructions: "fixture",
          },
        });
        return;
      }
      if (body.method === "tools/list") {
        respond({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "echo",
                description: "Echo",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
        return;
      }
      // Anything else (notably `initialize`) is a contract violation for
      // this fixture — fail loudly so a regression to the legacy path
      // can't pass silently.
      respond({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `unexpected method ${body.method}` },
      });
    }
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
    captured,
  };
}

describe("MCPClientManager mcpProtocolVersion: auto", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.reverse()) {
      await fn().catch(() => undefined);
    }
    cleanup = [];
  });

  it("detects a stateless RC server and connects via the preview client", async () => {
    const fixture = await startStatelessFixture();
    cleanup.push(fixture.close);
    const manager = new MCPClientManager();
    cleanup.push(() => manager.disconnectAllServers());

    await manager.connectToServer("auto-stateless", {
      url: fixture.url,
      mcpProtocolVersion: "auto",
    });

    expect(manager.getConnectionStatus("auto-stateless")).toBe("connected");
    // The probe is the connect — the fixture only speaks 2026-07-28, so a
    // successful connect already proves the stateless path won. Pin the
    // wire details anyway: discover ran, with the RC literal in the
    // header, and the legacy initialize handshake never fired.
    const methods = fixture.captured.map((r) => r.method);
    expect(methods).toContain("server/discover");
    expect(methods).not.toContain("initialize");
    const discover = fixture.captured.find(
      (r) => r.method === "server/discover"
    )!;
    expect(discover.headers["mcp-protocol-version"]).toBe("2026-07-28");

    const tools = await manager.listTools("auto-stateless");
    expect(tools.tools.map((t) => t.name)).toEqual(["echo"]);
  }, 15000);

  it("falls back to the legacy initialize path for a stateful server", async () => {
    const mock = await startMockStreamableHttpServer();
    cleanup.push(mock.stop);
    const manager = new MCPClientManager();
    cleanup.push(() => manager.disconnectAllServers());

    await manager.connectToServer("auto-stateful", {
      url: mock.url,
      mcpProtocolVersion: "auto",
    });

    expect(manager.getConnectionStatus("auto-stateful")).toBe("connected");
    const tools = await manager.listTools("auto-stateful");
    expect(tools.tools.length).toBe(MOCK_TOOLS.length);
  }, 15000);

  it("auto ignores a carried-over RC-only supportedProtocolVersions on the legacy fallback", async () => {
    // Stale-accept-list regression: a persisted host config can carry
    // `initialize.supportedProtocolVersions` (the canonicalizer's old
    // stateful derivation, or a hand-written RC-only list) alongside an
    // "auto" pin via the hosted/local plumbing. If that list reached the
    // legacy Client, initialize would propose 2026-07-28 and reject the
    // stateful server's counter-offer — auto must sanitize it and
    // negotiate with SDK defaults instead.
    const mock = await startMockStreamableHttpServer();
    cleanup.push(mock.stop);
    const manager = new MCPClientManager();
    cleanup.push(() => manager.disconnectAllServers());

    await manager.connectToServer("auto-stale-accept-list", {
      url: mock.url,
      mcpProtocolVersion: "auto",
      supportedProtocolVersions: ["2026-07-28"],
    });

    expect(manager.getConnectionStatus("auto-stale-accept-list")).toBe(
      "connected"
    );
    const tools = await manager.listTools("auto-stale-accept-list");
    expect(tools.tools.length).toBe(MOCK_TOOLS.length);
  }, 15000);

  it("auto ignores a stale single-version accept list on the legacy fallback", async () => {
    const mock = await startMockStreamableHttpServer();
    cleanup.push(mock.stop);
    const manager = new MCPClientManager();
    cleanup.push(() => manager.disconnectAllServers());

    await manager.connectToServer("auto-old-accept-list", {
      url: mock.url,
      mcpProtocolVersion: "auto",
      // The canonicalizer's derived shape for an old stateful pin.
      supportedProtocolVersions: ["2025-03-26"],
    });

    expect(manager.getConnectionStatus("auto-old-accept-list")).toBe(
      "connected"
    );
  }, 15000);

  it("explicit 2026-07-28 pin against a stateful server still fails (no silent fallback)", async () => {
    const mock = await startMockStreamableHttpServer();
    cleanup.push(mock.stop);
    const manager = new MCPClientManager();
    cleanup.push(() => manager.disconnectAllServers());

    await expect(
      manager.connectToServer("pinned-rc", {
        url: mock.url,
        mcpProtocolVersion: "2026-07-28",
      })
    ).rejects.toThrow();
  }, 15000);
});
