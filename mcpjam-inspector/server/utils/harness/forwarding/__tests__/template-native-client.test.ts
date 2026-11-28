/**
 * Each harness CLI's built-in template against its runtime's forwarding
 * contract.
 *
 * The template pins the handshake the contract measured, so a bridged turn
 * shows the server the CLI's own client, and pass-through forwarding is
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
import {
  seedHostTemplate,
  type HostTemplateId,
} from "@mcpjam/sdk/host-config/templates";
import { WEB_STREAM_TIMEOUT_MS } from "@/shared/hosted-web-timeouts";
import {
  HOSTED_APP_HANDLERS,
  qualifyHarnessHostCapabilities,
} from "@/shared/harness-host-capabilities";
import { toHttpConfig } from "../../../../routes/web/auth.js";
import { buildHostConnectionPins } from "../../../../services/host-connection-pins.js";
import { nativeForwardingGaps } from "../native-admission.js";
import { qualifiedForwardingRuntime } from "../runtime-contract.js";
import { getHarnessAdapter, type HarnessId } from "../../registry.js";

type Profile = ReturnType<typeof seedHostTemplate>;

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

/** A hosted chat turn's connection, with the live elicitation handler a
 * Playground turn registers whenever its client declares elicitation: the SDK
 * advertises elicitation only then. */
async function gapsFor(profile: Profile, harness: HarnessId) {
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
  manager.setElicitationCallback(async () => ({ action: "decline" }));
  await manager.connectToServer("server", config);
  expect(manager.getInitializationInfo("server")).toMatchObject({
    transport: "streamable-http",
  });
  const adapter = getHarnessAdapter(harness);
  return nativeForwardingGaps({
    manager,
    serverIds: ["server"],
    respectToolVisibility: profile.respectToolVisibility,
    modelVisibleMcpToolResults: profile.modelVisibleMcpToolResults,
    hostCapabilities: qualifyHarnessHostCapabilities(
      profile,
      HOSTED_APP_HANDLERS,
    ),
    elicitationRuntimeVersion: adapter.pinnedRuntimeVersion,
    nativeClient: qualifiedForwardingRuntime(adapter)?.nativeClient,
  });
}

/**
 * Each harness CLI template, its runtime, and the gaps its own settings still
 * add. Whether Claude Code and Codex hide App-only tools from their models
 * has not been measured, so those templates keep the visibility filter, and
 * it keeps them off pass-through. A turn hands a server's elicitation to its
 * handler only for Claude Code's measured profile, so the elicitation Codex
 * and Cursor CLI declare is a gap: on pass-through their own clients would
 * answer the server (Cursor CLI declines), where MCPJam's connection asks
 * the member.
 */
const TEMPLATES: Array<[HostTemplateId, HarnessId, string[]]> = [
  ["claude-code", "claude-code", ["tool-visibility"]],
  [
    "codex-cli",
    "codex",
    ["capability-overrides", "client-capabilities", "tool-visibility"],
  ],
  ["copilot-cli", "copilot-cli", []],
  ["cursor-cli", "cursor", ["capability-overrides", "client-capabilities"]],
];

describe.each(TEMPLATES)("the %s template", (templateId, harness, remaining) => {
  const template = () => seedHostTemplate(templateId);
  const native = () =>
    qualifiedForwardingRuntime(getHarnessAdapter(harness))?.nativeClient;

  it("starts new clients on its runtime with tool approval on", () => {
    expect(template()).toMatchObject({
      harness,
      requireToolApproval: true,
      connectionDefaults: { requestTimeout: 300_000 },
    });
  });

  it("pins the handshake its runtime's contract measured", () => {
    const measured = native();
    expect(measured).toBeDefined();
    const { initializePins } = buildHostConnectionPins(template(), 0);
    expect(template().clientCapabilities).toEqual(measured!.capabilities);
    expect(initializePins?.clientInfo).toEqual(measured!.clientInfo);
    expect(initializePins?.supportedProtocolVersions).toEqual(
      measured!.supportedProtocolVersions,
    );
    expect(initializePins?.mcpProtocolVersion).toEqual(
      measured!.mcpProtocolVersion,
    );
    expect(initializePins?.versionNegotiation).toEqual(
      measured!.versionNegotiation,
    );
  });

  it("adds no handshake gap on a hosted turn's own connection", async () => {
    expect((await gapsFor(template(), harness)).sort()).toEqual(
      [...remaining].sort(),
    );
  });
});

describe("the OpenCode template", () => {
  it("starts new clients on OpenCode with tool approval on, pinning nothing", () => {
    const template = seedHostTemplate("opencode");
    expect(template).toMatchObject({
      harness: "opencode",
      requireToolApproval: true,
      clientCapabilities: {},
      mcpProfile: { profileVersion: 1 },
    });
    // No handshake of OpenCode's own is measured yet, and it has no contract.
    expect(getHarnessAdapter("opencode").forwardingRuntime).toBeUndefined();
    expect(buildHostConnectionPins(template, 0).initializePins).toBeUndefined();
  });
});

describe("a client saved before its template carried the handshake", () => {
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

  it.each([
    ["catalog row", { roots: { listChanged: true }, elicitation: {} }],
    ["SDK seed", { roots: {}, elicitation: {} }],
  ])(
    "keeps Cursor CLI's configured route with every seeded pin of the %s",
    async (_source, clientCapabilities) => {
      expect(
        (await gapsFor(seededProfile(clientCapabilities), "cursor")).sort(),
      ).toEqual(
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

  it("keeps a Copilot CLI client with the old MCPJam pins off pass-through", async () => {
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

  it("still forwards a client saved with no pins at all", async () => {
    const unpinned = {
      ...seedHostTemplate("copilot-cli"),
      clientCapabilities: {},
      mcpProfile: { profileVersion: 1 },
    };
    expect(await gapsFor(unpinned, "copilot-cli")).toEqual([]);
  });
});
