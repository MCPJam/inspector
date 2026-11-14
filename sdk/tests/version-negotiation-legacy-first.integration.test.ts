import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMcpHandler,
  legacyStatelessFallback,
  McpServer,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import type { NegotiationOutcomeEvent } from "../src/mcp-client-manager/index.js";

/**
 * `versionNegotiation: "legacy-first"` against the official server package, in
 * the four shapes Cursor CLI 2026.11.05-86047df was measured on. The CLI:
 * opens with `initialize` at 2025-11-25 everywhere; stays there on a 2025-only
 * or both-era server and never sends `server/discover`; moves to
 * `server/discover` at 2026-07-28 only when a 2026-only server refuses with
 * `-32022` naming that revision; and on a generic `-32600` refusal makes one
 * GET and gives up.
 */
type Era = "legacy" | "both" | "modern" | "modern-generic-reject";

async function serve(era: Era) {
  const factory = () =>
    new McpServer(
      { name: `legacy-first-${era}`, version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
  const node = toNodeHandler(
    era === "legacy"
      ? { fetch: legacyStatelessFallback(factory) }
      : createMcpHandler(factory, era === "both" ? {} : { legacy: "reject" })
  );
  const wire: string[] = [];
  const httpServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text
      ? (JSON.parse(text) as { id?: unknown; method?: string })
      : undefined;
    wire.push(`${req.method} ${body?.method ?? "-"}`);
    if (era === "modern-generic-reject" && body?.method === "initialize") {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32600, message: "legacy era rejected" },
        })
      );
      return;
    }
    await node(req, res, body);
  });
  await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    wire,
    close: async () => {
      httpServer.closeAllConnections();
      await new Promise<void>((done) => httpServer.close(() => done()));
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect(
  era: Era,
  config: {
    supportedProtocolVersions?: string[];
    mcpProtocolVersion?: "2026-07-28";
  } = {}
) {
  const fixture = await serve(era);
  cleanups.push(fixture.close);
  const events: NegotiationOutcomeEvent[] = [];
  const manager = new MCPClientManager(
    {},
    { negotiationOutcomeLogger: (event) => events.push(event) }
  );
  cleanups.push(() => manager.disconnectAllServers());
  const connected = manager
    .connectToServer("server", {
      url: fixture.url,
      versionNegotiation: "legacy-first",
      timeout: 10_000,
      ...config,
    })
    .then(() => manager.getInitializationInfo("server")?.protocolVersion);
  return { connected, wire: fixture.wire, events };
}

describe('versionNegotiation: "legacy-first"', () => {
  it.each(["legacy", "both"] as const)(
    "stays on 2025-11-25 against a %s server and never sends server/discover",
    async (era) => {
      const { connected, wire, events } = await connect(era);
      await expect(connected).resolves.toBe("2025-11-25");
      expect(wire.slice(0, 2)).toEqual([
        "POST initialize",
        "POST notifications/initialized",
      ]);
      expect(wire).not.toContain("POST server/discover");
      expect(events).toMatchObject([
        {
          configuredMode: "legacy-first",
          negotiatedProtocolVersion: "2025-11-25",
        },
      ]);
    }
  );

  it("offers the first legacy version of the accept list", async () => {
    const { connected } = await connect("both", {
      supportedProtocolVersions: ["2025-06-18", "2025-11-25"],
    });
    await expect(connected).resolves.toBe("2025-06-18");
  });

  it("moves to 2026-07-28 through server/discover when -32022 names it", async () => {
    const { connected, wire } = await connect("modern");
    await expect(connected).resolves.toBe("2026-07-28");
    expect(wire.slice(0, 2)).toEqual([
      "POST initialize",
      "POST server/discover",
    ]);
  });

  it("fails on a generic refusal, after the one GET the CLI also makes", async () => {
    const { connected, wire } = await connect("modern-generic-reject");
    await expect(connected).rejects.toThrow(/legacy era rejected/);
    expect(wire).toEqual(["POST initialize", "GET -"]);
  });

  it("leaves a pinned connection to its pin", async () => {
    const { connected, wire } = await connect("both", {
      mcpProtocolVersion: "2026-07-28",
    });
    await expect(connected).resolves.toBe("2026-07-28");
    expect(wire[0]).toBe("POST server/discover");
  });
});
