import { describe, it, expect, afterEach, vi } from "vitest";
import { build } from "esbuild";
import { createTestApp, createMockMcpClientManager } from "./helpers/index.js";
import { isChromiumInstalled } from "../../../utils/mcp-app-browser-harness";

/**
 * widget-render.integration.test.ts — one real-Chromium render through the route
 * (no harness mock). Launches headless Chromium, so it runs only where one is
 * installed (CI + the hosted image) and skips in browser-less envs. Everything
 * else about the route is covered deterministically in widget-render.test.ts.
 */

const CHROMIUM_AVAILABLE = await isChromiumInstalled();

const MCP_APP_META = { ui: { resourceUri: "ui://widget/seats" } };

/**
 * Bundle a real ext-apps guest (it completes the ui/initialize handshake
 * against the harness's production host bridge, then paints), wrapped as widget
 * HTML — same fixture style as the harness suite.
 */
async function bundleGuestHtml(): Promise<string> {
  const src = `
    import { App } from "@modelcontextprotocol/ext-apps";
    const app = new App({ name: "widget-render-route-fixture", version: "1.0.0" });
    (async () => {
      await app.connect();
      const p = document.createElement("p");
      p.textContent = "Seat map";
      p.style.cssText = "font-size:24px;padding:24px";
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

describe.skipIf(!CHROMIUM_AVAILABLE)(
  "POST /api/mcp/widget-render — real harness integration",
  () => {
    // The harness disposes itself per-request (route `finally`); nothing to
    // tear down here, but keep the hook for symmetry with the harness suites.
    afterEach(() => {});

    it("renders an ext-apps fixture widget end-to-end", async () => {
      const html = await bundleGuestHtml();
      const mcpClientManager = createMockMcpClientManager({
        getAllToolsMetadata: vi
          .fn()
          .mockReturnValue({ show_seats: MCP_APP_META }),
        executeTool: vi
          .fn()
          .mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
        readResource: vi
          .fn()
          .mockResolvedValue({ contents: [{ text: html, _meta: { ui: {} } }] }),
      });
      const app = createTestApp(mcpClientManager, "widget-render");

      const res = await app.request("/api/mcp/widget-render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "flights",
          toolName: "show_seats",
          parameters: {},
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        status: string;
        screenshotBase64?: string;
        resourceUri?: string;
        bridgeInitialized?: boolean;
      };
      expect(data.status).toBe("rendered");
      expect(data.bridgeInitialized).toBe(true);
      expect(data.resourceUri).toBe("ui://widget/seats");
      expect((data.screenshotBase64 ?? "").length).toBeGreaterThan(0);
    }, 30_000);
  },
);
