import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import type { MrtrInputCollector } from "../src/mcp-client-manager/index.js";
import { createMrtrFixtureHandler } from "./support/mrtr-fixture.js";

/**
 * An MRTR input collector answers `elicitation` only on a 2026-era
 * connection: it cannot answer a server-to-client `elicitation/create`. So a
 * collector alone must not put `elicitation` on a 2025 `initialize` — a server
 * trusting that claim would ask a form and get `-32601` mid tool call — while
 * a connection that classifies as modern keeps advertising it.
 *
 * Wire-level: the real `MCPClientManager` against loopback HTTP servers.
 */

interface Served {
  url: string;
  /** `params.capabilities` of every `initialize` the server received. */
  initialize: Record<string, unknown>[];
  /** Client JSON-RPC errors answering server-to-client requests. */
  refusals: { code?: number }[];
  close: () => Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/**
 * A 2025-only stateful server: `server/discover` gets `-32601` (Auto falls
 * back to `initialize`), and its `ask` tool sends a standard form
 * `elicitation/create` exactly when the client declared elicitation.
 */
async function serveLegacy(): Promise<Served> {
  const initialize: Served["initialize"] = [];
  const refusals: Served["refusals"] = [];
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();
  const build = () => {
    const server = new McpServer(
      { name: "legacy-elicitation-fixture", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    server.registerTool("ask", { description: "Asks a form." }, async (ctx) => {
      if (!server.server.getClientCapabilities()?.elicitation) {
        return { content: [{ type: "text" as const, text: "no-form" }] };
      }
      const result = await ctx.mcpReq.elicitInput({
        mode: "form",
        message: "Answer?",
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
        },
      });
      return {
        content: [{ type: "text" as const, text: `form:${result.action}` }],
      };
    });
    return server;
  };
  const httpServer = http.createServer(async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? transports.get(sessionId) : undefined;
    if (req.method !== "POST") {
      if (!existing) {
        res.writeHead(405).end();
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }
    const body = (await readBody(req)) as {
      id?: unknown;
      method?: string;
      params?: { capabilities?: Record<string, unknown> };
      error?: { code?: number };
    };
    if (body?.method === "server/discover") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        })
      );
      return;
    }
    if (body?.method === "initialize") {
      initialize.push(body.params?.capabilities ?? {});
      const transport: NodeStreamableHTTPServerTransport =
        new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
      await build().connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (body && !body.method && body.error) refusals.push(body.error);
    if (!existing) {
      res.writeHead(400).end();
      return;
    }
    await existing.handleRequest(req, res, body);
  });
  await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`,
    initialize,
    refusals,
    close: async () => {
      await Promise.allSettled([...transports.values()].map((t) => t.close()));
      httpServer.closeAllConnections();
      await new Promise<void>((done) => httpServer.close(() => done()));
    },
  };
}

async function serveModern(): Promise<Served> {
  const httpServer = http.createServer(
    toNodeHandler(createMrtrFixtureHandler())
  );
  await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`,
    initialize: [],
    refusals: [],
    close: async () => {
      httpServer.closeAllConnections();
      await new Promise<void>((done) => httpServer.close(() => done()));
    },
  };
}

function acceptAll(answer: string): MrtrInputCollector {
  return async ({ inputRequests }) =>
    Object.fromEntries(
      Object.keys(inputRequests).map((key) => [
        key,
        { action: "accept", content: { answer } },
      ])
    );
}

type ToolText = { isError?: boolean; content: Array<{ text?: string }> };

describe("an MRTR collector's elicitation claim follows the negotiated era", () => {
  let served: Served | undefined;
  let manager: MCPClientManager | undefined;

  afterEach(async () => {
    await manager?.disconnectAllServers().catch(() => {});
    await served?.close();
    manager = undefined;
    served = undefined;
  });

  it.each([
    ["an unpinned (Auto) connection", undefined],
    ["a 2025 pin", "2025-11-25"],
  ])(
    "%s landing on 2025 claims no elicitation a collector cannot answer",
    async (_label, mcpProtocolVersion) => {
      served = await serveLegacy();
      const collect = vi.fn(acceptAll("never"));
      manager = new MCPClientManager();
      manager.setMrtrInputCollector("fixture", collect);
      await manager.connectToServer("fixture", {
        url: served.url,
        timeout: 10_000,
        ...(mcpProtocolVersion ? { mcpProtocolVersion } : {}),
        // An exact set naming form support, as the hosted plugin runtime pins.
        clientCapabilities: { elicitation: { form: {} } },
      });
      expect(manager.getInitializationInfo("fixture")?.protocolVersion).toBe(
        "2025-11-25"
      );
      expect(served.initialize).toHaveLength(1);
      expect(served.initialize[0]!.elicitation).toBeUndefined();

      const result = (await manager.executeTool(
        "fixture",
        "ask",
        {}
      )) as ToolText;
      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toBe("no-form");
      expect(served.refusals).toEqual([]);
      expect(collect).not.toHaveBeenCalled();
    }
  );

  it("keeps the claim on 2025 when a legacy elicitation handler answers it (control)", async () => {
    served = await serveLegacy();
    manager = new MCPClientManager();
    manager.setMrtrInputCollector("fixture", acceptAll("never"));
    manager.setElicitationHandler("fixture", async () => ({
      action: "accept" as const,
      content: { answer: "legacy" },
    }));
    await manager.connectToServer("fixture", {
      url: served.url,
      timeout: 10_000,
      clientCapabilities: { elicitation: { form: {} } },
    });
    expect(served.initialize[0]!.elicitation).toEqual({ form: {} });
    const result = (await manager.executeTool(
      "fixture",
      "ask",
      {}
    )) as ToolText;
    expect(result.content[0]?.text).toBe("form:accept");
  });

  it.each([
    ["an unpinned (Auto) connection", undefined],
    ["a 2026 pin", "2026-07-28"],
  ])(
    "%s landing on 2026-07-28 keeps the collector's elicitation claim",
    async (_label, mcpProtocolVersion) => {
      served = await serveModern();
      const collect = vi.fn(acceptAll("apples"));
      manager = new MCPClientManager();
      manager.setMrtrInputCollector("fixture", collect);
      await manager.connectToServer("fixture", {
        url: served.url,
        timeout: 10_000,
        ...(mcpProtocolVersion ? { mcpProtocolVersion } : {}),
        clientCapabilities: { elicitation: { form: {} } },
      });
      const info = manager.getInitializationInfo("fixture");
      expect(info?.protocolVersion).toBe("2026-07-28");
      expect(
        (info?.clientCapabilities as Record<string, unknown>).elicitation
      ).toEqual({ form: {} });
      // The server embeds a form only when the request envelope declares it
      // (otherwise -32021); the collector answers it.
      const result = (await manager.executeTool("fixture", "confirm", {
        topic: "fruit",
      })) as ToolText;
      expect(result.content[0]?.text).toBe("answer:apples");
      expect(collect).toHaveBeenCalledOnce();
    }
  );
});
