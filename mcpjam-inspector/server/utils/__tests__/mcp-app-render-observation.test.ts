import { describe, it, expect, vi, afterEach } from "vitest";
import { build } from "esbuild";
import {
  renderMcpAppToolResult,
  isRenderableMcpAppTool,
} from "../mcp-app-render-observation";
import { McpAppBrowserHarness } from "../mcp-app-browser-harness";
import type { MCPClientManager } from "@mcpjam/sdk";

const MCP_APP_META = { ui: { resourceUri: "ui://widget/seats" } };

describe("isRenderableMcpAppTool", () => {
  it("accepts MCP App tools that declare a UI resource", () => {
    expect(isRenderableMcpAppTool(MCP_APP_META)).toBe(true);
  });
  it("rejects non-MCP-App / resource-less metadata", () => {
    expect(isRenderableMcpAppTool({})).toBe(false);
    expect(isRenderableMcpAppTool({ ui: {} })).toBe(false);
    expect(isRenderableMcpAppTool(undefined)).toBe(false);
  });
});

describe("renderMcpAppToolResult — short-circuits", () => {
  const stubHarness = () =>
    ({ renderWidget: vi.fn() } as unknown as McpAppBrowserHarness);

  it("returns no_ui_resource without touching the harness", async () => {
    const harness = stubHarness();
    const obs = await renderMcpAppToolResult({
      toolCallId: "tc",
      toolName: "t",
      serverId: "s",
      toolMetadata: {},
      mcpClientManager: {} as MCPClientManager,
      harness,
    });
    expect(obs.status).toBe("no_ui_resource");
    expect(
      harness.renderWidget as ReturnType<typeof vi.fn>
    ).not.toHaveBeenCalled();
  });

  it("returns resource_read_failed when readResource throws", async () => {
    const harness = stubHarness();
    const mcpClientManager = {
      readResource: vi.fn().mockRejectedValue(new Error("nope")),
    } as unknown as MCPClientManager;
    const obs = await renderMcpAppToolResult({
      toolCallId: "tc",
      toolName: "t",
      serverId: "s",
      toolMetadata: MCP_APP_META,
      mcpClientManager,
      harness,
    });
    expect(obs.status).toBe("resource_read_failed");
    expect(obs.resourceUri).toBe("ui://widget/seats");
  });
});

describe("renderMcpAppToolResult — reads resource + delegates to harness", () => {
  function setup(html: string) {
    const renderWidget = vi.fn(
      async (input: { toolCallId: string; html: string }) => ({
        toolCallId: input.toolCallId,
        toolName: "t",
        serverId: "s",
        status: "rendered" as const,
        bridgeInitialized: true,
        elapsedMs: 1,
        ts: Date.now(),
        _html: input.html,
      })
    );
    const harness = { renderWidget } as unknown as McpAppBrowserHarness;
    const mcpClientManager = {
      readResource: vi.fn().mockResolvedValue({
        contents: [{ text: html, _meta: { ui: { permissions: {} } } }],
      }),
    } as unknown as MCPClientManager;
    return { harness, renderWidget, mcpClientManager };
  }

  it("passes the raw widget HTML through when the shim is off", async () => {
    const html = "<html><body>seats</body></html>";
    const { harness, renderWidget, mcpClientManager } = setup(html);
    const obs = await renderMcpAppToolResult({
      toolCallId: "tc1",
      toolName: "show_seats",
      serverId: "flights",
      toolMetadata: MCP_APP_META,
      output: { content: [] },
      mcpClientManager,
      harness,
      keepMounted: true,
    });
    expect(obs.status).toBe("rendered");
    const arg = renderWidget.mock.calls[0][0] as {
      html: string;
      keepMounted?: boolean;
    };
    expect(arg.html).toBe(html);
    expect(arg.keepMounted).toBe(true);
  });

  it("injects the OpenAI compat shim when enabled", async () => {
    const html = "<html><body>seats</body></html>";
    const { harness, renderWidget, mcpClientManager } = setup(html);
    await renderMcpAppToolResult({
      toolCallId: "tc1",
      toolName: "show_seats",
      serverId: "flights",
      toolMetadata: MCP_APP_META,
      output: { content: [] },
      mcpClientManager,
      harness,
      injectOpenAiCompat: true,
    });
    const arg = renderWidget.mock.calls[0][0] as { html: string };
    // The shim injects the OpenAI Apps runtime (defines window.openai), so the
    // HTML grows and references the openai surface.
    expect(arg.html).not.toBe(html);
    expect(arg.html.length).toBeGreaterThan(html.length);
    expect(arg.html).toContain("openai");
  });

  function setupWithMeta(meta: Record<string, unknown>) {
    const renderWidget = vi.fn(async () => ({
      toolCallId: "tc",
      toolName: "t",
      serverId: "s",
      status: "rendered" as const,
      elapsedMs: 1,
      ts: Date.now(),
    }));
    const harness = { renderWidget } as unknown as McpAppBrowserHarness;
    const mcpClientManager = {
      readResource: vi.fn().mockResolvedValue({
        contents: [{ text: "<html><body>w</body></html>", _meta: meta }],
      }),
    } as unknown as MCPClientManager;
    return { harness, renderWidget, mcpClientManager };
  }

  it("normalizes SEP-1865 _meta.ui.csp into the harness cspMeta (Excalidraw shape)", async () => {
    // Mirrors the live Excalidraw widget resource: camelCase domains under
    // `_meta.ui.csp` — the declaration the network gate must honor for the
    // widget's esm.sh bundle to load instead of blank-painting.
    const { harness, renderWidget, mcpClientManager } = setupWithMeta({
      ui: {
        csp: {
          resourceDomains: ["https://esm.sh"],
          connectDomains: ["https://esm.sh"],
        },
        permissions: {},
      },
    });
    await renderMcpAppToolResult({
      toolCallId: "tc-csp",
      toolName: "create_view",
      serverId: "excalidraw",
      toolMetadata: MCP_APP_META,
      mcpClientManager,
      harness,
    });
    const arg = renderWidget.mock.calls[0][0] as {
      cspMeta?: { connect_domains?: string[]; resource_domains?: string[] };
    };
    expect(arg.cspMeta).toEqual({
      connect_domains: ["https://esm.sh"],
      resource_domains: ["https://esm.sh"],
    });
  });

  it("normalizes legacy openai/widgetCSP and omits cspMeta when undeclared", async () => {
    const legacy = setupWithMeta({
      "openai/widgetCSP": { connect_domains: ["https://api.example.com"] },
    });
    await renderMcpAppToolResult({
      toolCallId: "tc-legacy",
      toolName: "t",
      serverId: "s",
      toolMetadata: MCP_APP_META,
      mcpClientManager: legacy.mcpClientManager,
      harness: legacy.harness,
    });
    expect(
      (legacy.renderWidget.mock.calls[0][0] as { cspMeta?: unknown }).cspMeta
    ).toEqual({ connect_domains: ["https://api.example.com"] });

    const bare = setupWithMeta({ ui: { permissions: {} } });
    await renderMcpAppToolResult({
      toolCallId: "tc-bare",
      toolName: "t",
      serverId: "s",
      toolMetadata: MCP_APP_META,
      mcpClientManager: bare.mcpClientManager,
      harness: bare.harness,
    });
    expect(
      (bare.renderWidget.mock.calls[0][0] as { cspMeta?: unknown }).cspMeta
    ).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Integration: real harness end-to-end (renders a handshaking widget).
 * ------------------------------------------------------------------ */
const harnesses: McpAppBrowserHarness[] = [];
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose();
});

async function bundleGuestHtml(): Promise<string> {
  const src = `
    import { App } from "@modelcontextprotocol/ext-apps";
    const app = new App({ name: "render-obs-fixture", version: "1.0.0" });
    (async () => {
      await app.connect();
      const p = document.createElement("p");
      p.textContent = "Seat map";
      p.style.cssText = "font-size:20px;padding:16px";
      document.body.appendChild(p);
    })();
  `;
  const r = await build({
    stdin: { contents: src, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${r.outputFiles[0].text}</script></body></html>`;
}

describe("renderMcpAppToolResult — real harness integration", () => {
  it("reads the resource and renders the widget in headless Chromium", async () => {
    const html = await bundleGuestHtml();
    const harness = new McpAppBrowserHarness({
      callTool: async () => ({ content: [] }),
      budgets: { renderTimeoutMs: 1500 },
    });
    harnesses.push(harness);
    const mcpClientManager = {
      readResource: vi.fn().mockResolvedValue({
        contents: [{ text: html, _meta: { ui: {} } }],
      }),
    } as unknown as MCPClientManager;

    const obs = await renderMcpAppToolResult({
      toolCallId: "tc-real",
      toolName: "show_seats",
      serverId: "flights",
      toolMetadata: MCP_APP_META,
      output: { content: [{ type: "text", text: "ok" }] },
      mcpClientManager,
      harness,
      keepMounted: true,
    });

    expect(mcpClientManager.readResource).toHaveBeenCalledWith("flights", {
      uri: "ui://widget/seats",
    });
    expect(obs.status).toBe("rendered");
    expect(obs.bridgeInitialized).toBe(true);
    expect(obs.screenshotBase64 && obs.screenshotBase64.length).toBeGreaterThan(
      0
    );
    expect(harness.hasRenderedWidget()).toBe(true);
  }, 30_000);
});
