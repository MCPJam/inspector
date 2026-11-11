/**
 * The built-in Cursor CLI and GitHub Copilot CLI profiles against native
 * forwarding admission.
 *
 * Pass-through forwards MCP traffic exactly as the real CLI sends it, so it is
 * admitted only when MCPJam's own connection to each server adds nothing the
 * CLI's would not. The profile goes through the same mapping a hosted turn
 * uses (`buildHostConnectionPins`, then `toHttpConfig`) into a real
 * `MCPClientManager`, connected to a 2025-only loopback server, so the
 * negotiated version and the advertised capabilities are the SDK's own.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { MCPClientManager } from "@mcpjam/sdk";
import { seedHostTemplate } from "@mcpjam/sdk/host-config/templates";
import { WEB_STREAM_TIMEOUT_MS } from "@/shared/hosted-web-timeouts";
import { toHttpConfig } from "../../../../routes/web/auth.js";
import { buildHostConnectionPins } from "../../../../services/host-connection-pins.js";
import { nativeForwardingGaps } from "../native-admission.js";
import { qualifiedForwardingRuntime } from "../runtime-contract.js";
import { getHarnessAdapter } from "../../registry.js";

type Profile = ReturnType<typeof seedHostTemplate>;

/** What the built-in templates seeded before they dropped their pins: the
 * catalog row's capability claim, and the SDK seed's bare `roots`. */
const seededProfile = (clientCapabilities: Record<string, unknown>) => ({
  ...seedHostTemplate("cursor-cli"),
  respectToolVisibility: true,
  connectionDefaults: { headers: {}, requestTimeout: 10_000 },
  clientCapabilities,
  mcpProfile: {
    profileVersion: 1,
    initialize: {
      supportedProtocolVersions: ["2025-11-25"],
      clientInfo: {
        name: "cursor-agent",
        title: "Cursor CLI",
        version: "2026.08.31-4057e58",
        description: "Cursor's agentic coding CLI",
        websiteUrl: "https://cursor.com/cli",
      },
    },
  },
});

/** Answers `server/discover` with -32601, so an unpinned client falls back to
 * the 2025 `initialize`, and serves each request statelessly. */
async function serveLegacy() {
  const httpServer = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: unknown;
      method?: string;
    };
    if (body.method === "server/discover") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        }),
      );
      return;
    }
    const server = new McpServer(
      { name: "legacy-fixture", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
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

async function gapsFor(profile: Profile, runtime: "cursor" | "copilot-cli" = "cursor") {
  const fixture = await serveLegacy();
  cleanups.push(fixture.close);
  const pins = buildHostConnectionPins(profile, WEB_STREAM_TIMEOUT_MS);
  const config = toHttpConfig(
    { serverConfig: { transportType: "http", url: fixture.url } },
    pins.timeoutMs,
    undefined,
    profile.clientCapabilities,
    undefined,
    pins.initializePins,
  );
  const manager = new MCPClientManager();
  cleanups.push(() => manager.disconnectAllServers());
  await manager.connectToServer("server", config);
  expect(manager.getInitializationInfo("server")).toMatchObject({
    protocolVersion: "2025-11-25",
    transport: "streamable-http",
  });
  return nativeForwardingGaps({
    manager,
    serverIds: ["server"],
    respectToolVisibility: profile.respectToolVisibility,
    modelVisibleMcpToolResults: profile.modelVisibleMcpToolResults,
    nativeVersionNegotiation: qualifiedForwardingRuntime(
      getHarnessAdapter(runtime),
    )?.nativeVersionNegotiation,
  });
}

describe("built-in Cursor CLI profile", () => {
  it("adds nothing the real CLI's connection would not, so pass-through is admitted", async () => {
    expect(await gapsFor(seedHostTemplate("cursor-cli"))).toEqual([]);
  });

  it.each([
    ["catalog row", { roots: { listChanged: true }, elicitation: {} }],
    ["SDK seed", { roots: {}, elicitation: {} }],
  ])(
    "keeps the configured route with every seeded pin of the %s",
    async (_source, clientCapabilities) => {
      expect((await gapsFor(seededProfile(clientCapabilities))).sort()).toEqual(
        [
          "tool-visibility",
          "request-timeout",
          "client-capabilities",
          "capability-overrides",
          "protocol-pins",
          "client-identity",
        ].sort(),
      );
    },
  );
});

describe("built-in GitHub Copilot CLI profile", () => {
  it("adds nothing the real CLI's connection would not, so pass-through is admitted", async () => {
    expect(await gapsFor(seedHostTemplate("copilot-cli"), "copilot-cli")).toEqual([]);
  });

  it("keeps a client saved with the old MCPJam pins off pass-through", async () => {
    const saved = {
      ...seedHostTemplate("copilot-cli"),
      respectToolVisibility: true,
      connectionDefaults: { headers: {}, requestTimeout: 10_000 },
      mcpProfile: {
        profileVersion: 1,
        initialize: {
          supportedProtocolVersions: ["2025-11-25"],
          clientInfo: { name: "MCPJam", version: "1.0" },
        },
      },
    };
    expect((await gapsFor(saved, "copilot-cli")).sort()).toEqual(
      ["client-identity", "protocol-pins", "request-timeout", "tool-visibility"].sort(),
    );
  });
});
