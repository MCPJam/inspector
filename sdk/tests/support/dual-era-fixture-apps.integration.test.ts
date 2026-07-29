/**
 * MCP Apps preserved across protocol eras (Phase 3 §11.4 regression gate).
 *
 * The ui:// fetch and app-to-server tool calls already funnel through the
 * shared MCPClientManager, so era negotiation (legacy vs 2026-07-28 pin) is
 * inherited rather than special-cased — but nothing exercised Apps on a
 * modern connection before this file. Parameterized over both eras against a
 * real MCPClientManager talking to the dual-era fixture (apps: true) over a
 * real loopback HTTP server.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { McpProtocolVersion } from "../../src/mcp-client-manager/mcp-protocol-version.js";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import { isMcpAppTool } from "../../src/mcp-client-manager/tool-converters.js";
import {
  createFixtureHandler,
  FIXTURE_APP_MIME_TYPE,
  FIXTURE_APP_WIDGET_OVERRIDE_URI,
  FIXTURE_APP_WIDGET_URI,
} from "./dual-era-fixture.js";
import {
  createCapturingFetch,
  getWireField,
  type CapturingFetch,
  type RawExchange,
} from "./raw-capture.js";

interface ServedFixture {
  url: string;
  close: () => Promise<void>;
}

async function serveFixtureOnPort(): Promise<ServedFixture> {
  const handler = createFixtureHandler({ apps: true });
  const httpServer = http.createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

function byMethod(
  exchanges: RawExchange[],
  method: string,
): RawExchange | undefined {
  return exchanges.find((e) => getWireField(e.request.json, "method") === method);
}

/** Swap globalThis.fetch for a capturing fetch (still dials the real port). */
async function withCapturingFetch<T>(
  run: (cap: CapturingFetch) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const cap = createCapturingFetch(originalFetch.bind(globalThis));
  globalThis.fetch = cap.fetch as typeof fetch;
  try {
    return await run(cap);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

interface EraCase {
  label: string;
  mcpProtocolVersion?: McpProtocolVersion;
}

const ERAS: EraCase[] = [
  { label: "legacy (no pin)" },
  { label: "modern (2026-07-28)", mcpProtocolVersion: "2026-07-28" },
];

describe.each(ERAS)("MCP Apps on the $label era", ({ mcpProtocolVersion }) => {
  let served: ServedFixture;
  let manager: MCPClientManager;

  beforeEach(async () => {
    served = await serveFixtureOnPort();
    manager = new MCPClientManager();
  });

  afterEach(async () => {
    await manager.disconnectAllServers().catch(() => {});
    await served.close();
  });

  it("detects both the nested and deprecated-flat MCP App tools via isMcpAppTool", async () => {
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion,
      timeout: 10_000,
    });

    const { tools } = await manager.listTools("fixture");
    const byName = new Map(tools.map((t) => [t.name, t]));

    const nested = byName.get("show-widget");
    const flat = byName.get("show-widget-flat");
    expect(nested, "show-widget listed").toBeDefined();
    expect(flat, "show-widget-flat listed").toBeDefined();
    expect(
      isMcpAppTool(nested?._meta as Record<string, unknown> | undefined),
    ).toBe(true);
    expect(
      isMcpAppTool(flat?._meta as Record<string, unknown> | undefined),
    ).toBe(true);
  });

  it("reads the ui:// resource and gets back the mcp-app HTML", async () => {
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion,
      timeout: 10_000,
    });

    const result = await manager.readResource("fixture", {
      uri: FIXTURE_APP_WIDGET_URI,
    });
    const contents = Array.isArray(result.contents) ? result.contents : [];
    expect(contents).toHaveLength(1);
    const content = contents[0] as {
      mimeType?: string;
      text?: string;
    };
    expect(content.mimeType).toBe(FIXTURE_APP_MIME_TYPE);
    expect(content.text).toContain("fixture widget");
  });

  it("calls the app-to-server tool successfully", async () => {
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion,
      timeout: 10_000,
    });

    const result = (await manager.executeTool(
      "fixture",
      "show-widget",
      {},
    )) as CallToolResult;
    expect(result.isError).not.toBe(true);
    expect(Array.isArray(result.content) ? result.content.length : 0).toBeGreaterThan(0);
  });

  it("the call result's content-item _meta.ui.resourceUri takes precedence over the listing metadata", async () => {
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion,
      timeout: 10_000,
    });

    const { tools } = await manager.listTools("fixture");
    const listed = tools.find((t) => t.name === "show-widget");
    const listedMeta = listed?._meta as
      | { ui?: { resourceUri?: unknown } }
      | undefined;
    // The tool-listing declaration points at the plain widget URI.
    expect(listedMeta?.ui?.resourceUri).toBe(FIXTURE_APP_WIDGET_URI);

    const result = (await manager.executeTool(
      "fixture",
      "show-widget",
      {},
    )) as CallToolResult;
    const first = Array.isArray(result.content) ? result.content[0] : undefined;
    const contentMeta = (first as { _meta?: { ui?: { resourceUri?: unknown } } })
      ?._meta;
    // The result's own content-item _meta carries a DIFFERENT resourceUri —
    // that is the one a host must render for this specific call, taking
    // precedence over the static tool-listing declaration.
    expect(contentMeta?.ui?.resourceUri).toBe(FIXTURE_APP_WIDGET_OVERRIDE_URI);
    expect(contentMeta?.ui?.resourceUri).not.toBe(listedMeta?.ui?.resourceUri);
  });

  it("carries the era-correct client-capability extension carrier alongside the negotiated protocol version", async () => {
    const cap = await withCapturingFetch(async (cap) => {
      await manager.connectToServer("fixture", {
        url: served.url,
        mcpProtocolVersion,
        timeout: 10_000,
      });
      await manager.listTools("fixture");
      return cap;
    });

    if (mcpProtocolVersion === "2026-07-28") {
      const list = byMethod(cap.exchanges, "tools/list");
      expect(list, "tools/list exchange captured").toBeDefined();
      expect(
        getWireField(list!.request.json, [
          "params",
          "_meta",
          "io.modelcontextprotocol/protocolVersion",
        ]),
      ).toBe("2026-07-28");
      const extension = getWireField(list!.request.json, [
        "params",
        "_meta",
        "io.modelcontextprotocol/clientCapabilities",
        "extensions",
        "io.modelcontextprotocol/ui",
      ]) as { mimeTypes?: unknown } | undefined;
      expect(extension?.mimeTypes).toContain(FIXTURE_APP_MIME_TYPE);
    } else {
      const init = byMethod(cap.exchanges, "initialize");
      expect(init, "initialize exchange captured").toBeDefined();
      const extension = getWireField(init!.request.json, [
        "params",
        "capabilities",
        "extensions",
        "io.modelcontextprotocol/ui",
      ]) as { mimeTypes?: unknown } | undefined;
      expect(extension?.mimeTypes).toContain(FIXTURE_APP_MIME_TYPE);
    }
  });

  it("the modern result stays a plain JSON boundary (JSON.parse(JSON.stringify(result)) deep-equals result)", async () => {
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion,
      timeout: 10_000,
    });

    const result = await manager.executeTool("fixture", "show-widget", {});
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
