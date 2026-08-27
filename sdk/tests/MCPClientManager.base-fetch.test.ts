/**
 * `baseFetch`: the seam that puts the REAL MCP connection under the same guard
 * as the raw probes beside it.
 *
 * Before it existed, a hosted conformance run guarded its raw HTTP probes with
 * a hop-checking fetch and then opened its one actual MCP connection through
 * the global `fetch`, following whatever redirects the target returned. The
 * suite's own comment said so. These tests pin the two properties that make
 * the closure real:
 *
 *   1. the transport dials through the injected fetch — every request, not
 *      just the first;
 *   2. it is the INNERMOST layer, so the guard sees the request that actually
 *      leaves, headers and all.
 *
 * The third test is the regression guard: absent `baseFetch`, nothing changes.
 */

import http from "http";
import type { AddressInfo } from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { MCPClientManager } from "../src/mcp-client-manager";
import { createMockServer } from "./mock-servers";

const stops: Array<() => Promise<void>> = [];

async function startStreamableServer(): Promise<string> {
  const mcpServer = createMockServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => `session-${Math.random()}`,
  });
  await mcpServer.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    if (req.url === "/mcp") {
      await transport.handleRequest(req, res);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  return await new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address() as AddressInfo;
      stops.push(
        () =>
          new Promise<void>((done) => {
            httpServer.closeAllConnections?.();
            httpServer.close(() => done());
          }),
      );
      resolve(`http://127.0.0.1:${address.port}/mcp`);
    });
  });
}

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

describe("baseFetch on the server config", () => {
  it("carries every transport request, not just the handshake", async () => {
    const url = await startStreamableServer();
    const spy = vi.fn<typeof fetch>((input, init) => fetch(input as never, init));

    const manager = new MCPClientManager();
    try {
      await manager.connectToServer("s", { url, baseFetch: spy });
      // A second round trip, after the handshake, must also be on the seam.
      await manager.listTools("s");
    } finally {
      await manager.disconnectAllServers();
    }

    expect(spy.mock.calls.length).toBeGreaterThan(1);
    for (const [input] of spy.mock.calls) {
      const dialled =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      expect(dialled).toContain(new URL(url).host);
    }
  });

  it("is the innermost layer, so it observes the headers that actually leave", async () => {
    const url = await startStreamableServer();
    const seen: Array<Record<string, string>> = [];
    const spy: typeof fetch = (input, init) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return fetch(input as never, init);
    };

    const manager = new MCPClientManager();
    try {
      await manager.connectToServer("s", {
        url,
        baseFetch: spy,
        requestInit: { headers: { "x-canary": "present" } },
      });
    } finally {
      await manager.disconnectAllServers();
    }

    expect(seen.some((headers) => headers["x-canary"] === "present")).toBe(true);
  });

  it("falls back to the manager default, and to the global fetch when neither is set", async () => {
    const url = await startStreamableServer();
    const managerDefault = vi.fn<typeof fetch>((input, init) =>
      fetch(input as never, init),
    );

    const withDefault = new MCPClientManager({}, { baseFetch: managerDefault });
    try {
      await withDefault.connectToServer("s", { url });
    } finally {
      await withDefault.disconnectAllServers();
    }
    expect(managerDefault).toHaveBeenCalled();

    // No `baseFetch` anywhere: the connection still works, on the global
    // fetch. A FRESH server, because the mock's transport accepts exactly one
    // initialize and a second handshake against it fails for reasons that have
    // nothing to do with what this asserts.
    const plainUrl = await startStreamableServer();
    const plain = new MCPClientManager();
    try {
      await expect(
        plain.connectToServer("s", { url: plainUrl }),
      ).resolves.not.toThrow();
    } finally {
      await plain.disconnectAllServers();
    }
  });

  it("lets the per-server value win over the manager default", async () => {
    const url = await startStreamableServer();
    const managerDefault = vi.fn<typeof fetch>((input, init) =>
      fetch(input as never, init),
    );
    const perServer = vi.fn<typeof fetch>((input, init) =>
      fetch(input as never, init),
    );

    const manager = new MCPClientManager({}, { baseFetch: managerDefault });
    try {
      await manager.connectToServer("s", { url, baseFetch: perServer });
    } finally {
      await manager.disconnectAllServers();
    }

    expect(perServer).toHaveBeenCalled();
    expect(managerDefault).not.toHaveBeenCalled();
  });
});
