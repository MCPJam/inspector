import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let sseConstructedCount = 0;

vi.mock("@modelcontextprotocol/client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@modelcontextprotocol/client")
  >();
  class SpySSEClientTransport extends actual.SSEClientTransport {
    constructor(url: URL, opts?: Record<string, unknown>) {
      super(url, opts as never);
      sseConstructedCount += 1;
    }
  }
  return {
    ...actual,
    SSEClientTransport: SpySSEClientTransport,
  };
});

const { MCPClientManager } = await import("../src/mcp-client-manager/index.js");

const NEGOTIATED_VERSION = "2025-06-18";
const STALE_ACCEPT_LIST = ["2025-11-25"];

interface CapturedRequest {
  httpMethod: string;
  rpcMethod?: string;
  proposedProtocolVersion?: string;
}

interface ServedLegacyFixture {
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

async function serveLegacyFixture(): Promise<ServedLegacyFixture> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      requests.push({ httpMethod: req.method ?? "unknown" });
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: string | number;
      method?: string;
      params?: { protocolVersion?: string };
    };
    requests.push({
      httpMethod: "POST",
      rpcMethod: body.method,
      proposedProtocolVersion: body.params?.protocolVersion,
    });

    const respond = (payload: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (body.method === "server/discover") {
      respond({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: "Method not found" },
      });
      return;
    }

    if (body.method === "initialize") {
      respond({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: NEGOTIATED_VERSION,
          capabilities: {},
          serverInfo: { name: "bart-fixture", version: "1.0.0" },
        },
      });
      return;
    }

    if (body.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }

    respond({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: "Method not found" },
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

describe("MCPClientManager Automatic legacy fallback", () => {
  let fixture: ServedLegacyFixture;
  let manager: MCPClientManager;

  beforeEach(async () => {
    sseConstructedCount = 0;
    fixture = await serveLegacyFixture();
    manager = new MCPClientManager();
  });

  afterEach(async () => {
    await manager.disconnectAllServers().catch(() => {});
    await fixture.close();
  });

  it("honors a per-server support list after disconnect and reconnect", async () => {
    await manager.connectToServer("bart", {
      url: fixture.url,
      timeout: 5_000,
    });
    expect(manager.getInitializationInfo("bart")?.protocolVersion).toBe(
      NEGOTIATED_VERSION
    );

    await manager.removeServer("bart");
    await expect(
      manager.connectToServer("bart", {
        url: fixture.url,
        timeout: 5_000,
        supportedProtocolVersions: STALE_ACCEPT_LIST,
      })
    ).rejects.toThrow(/Server's protocol version is not supported: 2025-06-18/);
    const initializeRequests = fixture.requests.filter(
      (request) => request.rpcMethod === "initialize"
    );
    expect(initializeRequests).toHaveLength(2);
    expect(
      initializeRequests.map((request) => request.proposedProtocolVersion)
    ).toEqual(["2025-11-25", "2025-11-25"]);
    expect(sseConstructedCount).toBe(1);
  });

  it("honors the manager-default support list in Automatic mode", async () => {
    await manager.disconnectAllServers();
    manager = new MCPClientManager(
      {},
      { defaultSupportedProtocolVersions: STALE_ACCEPT_LIST }
    );

    await expect(
      manager.connectToServer("bart", {
        url: fixture.url,
        timeout: 5_000,
      })
    ).rejects.toThrow(/Server's protocol version is not supported: 2025-06-18/);
  });

  it("keeps an explicit legacy protocol pin strict", async () => {
    await expect(
      manager.connectToServer("bart", {
        url: fixture.url,
        timeout: 5_000,
        mcpProtocolVersion: "2025-11-25",
      })
    ).rejects.toThrow(/2025-06-18/);
  });

  it("preserves an explicit legacy multi-version accept-list", async () => {
    await manager.connectToServer("bart", {
      url: fixture.url,
      timeout: 5_000,
      mcpProtocolVersion: "2025-11-25",
      supportedProtocolVersions: ["2025-11-25", NEGOTIATED_VERSION],
    });

    expect(manager.getInitializationInfo("bart")?.protocolVersion).toBe(
      NEGOTIATED_VERSION
    );
  });

  it("proposes the PINNED version, not the accept-list's first entry", async () => {
    // The list says what this client can speak; the pin says which of those it
    // proposes. Upstream `Client` only ever reads element 0, so honoring the
    // pin means hoisting it. Before this, the list silently won and a user who
    // pinned 2025-06-18 watched 2025-11-25 go out on the wire.
    await manager.connectToServer("bart", {
      url: fixture.url,
      timeout: 5_000,
      mcpProtocolVersion: NEGOTIATED_VERSION,
      supportedProtocolVersions: ["2025-11-25", NEGOTIATED_VERSION],
    });

    const initializeRequests = fixture.requests.filter(
      (request) => request.rpcMethod === "initialize"
    );
    expect(
      initializeRequests.map((request) => request.proposedProtocolVersion)
    ).toEqual([NEGOTIATED_VERSION]);
  });

  it("keeps the unpinned entries as fallbacks when hoisting", async () => {
    // Hoisting must not collapse the list to `[pin]`: the remaining versions
    // are still accepted, so a server that counter-offers one of them
    // negotiates rather than failing.
    await manager.connectToServer("bart", {
      url: fixture.url,
      timeout: 5_000,
      mcpProtocolVersion: "2025-11-25",
      supportedProtocolVersions: [NEGOTIATED_VERSION, "2025-11-25"],
    });

    const initializeRequests = fixture.requests.filter(
      (request) => request.rpcMethod === "initialize"
    );
    // Pin went out first...
    expect(initializeRequests[0]?.proposedProtocolVersion).toBe("2025-11-25");
    // ...and the fixture's own 2025-06-18 counter-offer was still accepted.
    expect(manager.getInitializationInfo("bart")?.protocolVersion).toBe(
      NEGOTIATED_VERSION
    );
  });

  it("leaves a pin that the accept-list does not contain alone", async () => {
    // Hoisting an unlisted pin would put a version on the wire this client
    // never claimed to speak. `canonicalizeMcpProfile` rejects that pairing
    // for stateful host pins, so this only guards hand-built configs.
    await manager.connectToServer("bart", {
      url: fixture.url,
      timeout: 5_000,
      mcpProtocolVersion: "2025-03-26",
      supportedProtocolVersions: ["2025-11-25", NEGOTIATED_VERSION],
    });

    const initializeRequests = fixture.requests.filter(
      (request) => request.rpcMethod === "initialize"
    );
    expect(initializeRequests[0]?.proposedProtocolVersion).toBe("2025-11-25");
  });
});
