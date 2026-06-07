import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { build } from "esbuild";
import {
  McpAppBrowserHarness,
  ChromiumNotInstalledError,
  type McpAppBrowserHarnessOptions,
} from "../mcp-app-browser-harness";

/**
 * Bundle a guest widget fixture (TS using the real ext-apps App SDK) into a
 * self-contained browser IIFE, then wrap it as widget HTML. Using the real
 * guest SDK exercises the actual ui/initialize handshake against the harness's
 * production host bridge.
 */
async function bundleGuest(source: string): Promise<string> {
  const r = await build({
    stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  return r.outputFiles[0].text;
}

function guestHtml(js: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${js}</script></body></html>`;
}

// A guest that completes the handshake and renders a clickable button whose
// center sits at the viewport center (640,400). Clicking it calls a server tool.
const BUTTON_GUEST_SRC = `
import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "fixture-button", version: "1.0.0" });
(async () => {
  await app.connect();
  const b = document.createElement("button");
  b.id = "ok";
  b.textContent = "Reserve seat";
  b.style.cssText = "position:absolute;left:540px;top:370px;width:200px;height:60px;font-size:18px";
  b.addEventListener("click", () => {
    app.callServerTool({ name: "reserve", arguments: { seat: 12 } }).catch(() => {});
  });
  document.body.appendChild(b);
})();
`;

// A guest that completes the handshake but paints nothing -> blank_screenshot.
const BLANK_GUEST_SRC = `
import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "fixture-blank", version: "1.0.0" });
app.connect().catch(() => {});
`;

// Plain HTML with no guest SDK: paints text but never handshakes -> bridge_timeout.
const STATIC_NO_BRIDGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><p style="font-size:24px;padding:20px">Static content, no bridge handshake</p></body></html>`;

let buttonHtml = "";
let blankHtml = "";

beforeAll(async () => {
  buttonHtml = guestHtml(await bundleGuest(BUTTON_GUEST_SRC));
  blankHtml = guestHtml(await bundleGuest(BLANK_GUEST_SRC));
}, 60_000);

const harnesses: McpAppBrowserHarness[] = [];
function makeHarness(
  overrides: Partial<McpAppBrowserHarnessOptions> = {},
): McpAppBrowserHarness & { calls: Array<{ name: string }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = vi.fn(
    async (_serverId: string, name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "ok" }] };
    },
  );
  const h = new McpAppBrowserHarness({
    callTool,
    budgets: { renderTimeoutMs: 1200, settleTimeoutMs: 1200 },
    ...overrides,
  }) as McpAppBrowserHarness & { calls: typeof calls };
  h.calls = calls;
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  while (harnesses.length) {
    await harnesses.pop()!.dispose();
  }
});

describe("McpAppBrowserHarness — Chromium gating", () => {
  it("records browser_unavailable when Chromium is not installed", async () => {
    // Force the binary-missing path by overriding the launcher loader.
    class NoChromiumHarness extends McpAppBrowserHarness {
      protected async loadChromium() {
        return {
          executablePath: () => "/nonexistent/path/to/chromium",
          launch: async () => {
            throw new Error("should not launch");
          },
        } as never;
      }
    }
    const h = new NoChromiumHarness({
      callTool: async () => ({ content: [] }),
    });
    harnesses.push(h);
    const obs = await h.renderWidget({
      toolCallId: "tc-x",
      toolName: "show",
      serverId: "s1",
      html: "<html><body>hi</body></html>",
    });
    expect(obs.status).toBe("browser_unavailable");
    expect(ChromiumNotInstalledError).toBeTypeOf("function");
  });
});

describe("McpAppBrowserHarness — render classification", () => {
  it("classifies a handshaking, painting widget as rendered", async () => {
    const h = makeHarness();
    const obs = await h.renderWidget({
      toolCallId: "tc-1",
      toolName: "show_seats",
      serverId: "s1",
      html: buttonHtml,
      resourceUri: "ui://widget/seats",
    });
    expect(obs.status).toBe("rendered");
    expect(obs.bridgeInitialized).toBe(true);
    expect(obs.screenshotBase64 && obs.screenshotBase64.length).toBeGreaterThan(
      0,
    );
    // screenshot within the byte budget (256 KiB default).
    const bytes = Buffer.from(obs.screenshotBase64!, "base64").byteLength;
    expect(bytes).toBeLessThanOrEqual(256 * 1024);
  }, 30_000);

  it("classifies static HTML that never handshakes as bridge_timeout", async () => {
    const h = makeHarness();
    const obs = await h.renderWidget({
      toolCallId: "tc-2",
      toolName: "static",
      serverId: "s1",
      html: STATIC_NO_BRIDGE_HTML,
    });
    expect(obs.status).toBe("bridge_timeout");
    expect(obs.bridgeInitialized).toBe(false);
  }, 30_000);

  it("classifies a handshaking-but-empty widget as blank_screenshot", async () => {
    const h = makeHarness();
    const obs = await h.renderWidget({
      toolCallId: "tc-3",
      toolName: "blank",
      serverId: "s1",
      html: blankHtml,
    });
    expect(obs.status).toBe("blank_screenshot");
    expect(obs.bridgeInitialized).toBe(true);
  }, 30_000);
});

describe("McpAppBrowserHarness — interaction", () => {
  it("dispatches a widget-initiated tools/call from a click", async () => {
    const h = makeHarness();
    const render = await h.renderWidget({
      toolCallId: "tc-int",
      toolName: "show_seats",
      serverId: "flights",
      html: buttonHtml,
      keepMounted: true,
    });
    expect(render.status).toBe("rendered");
    expect(h.hasRenderedWidget()).toBe(true);

    const result = await h.executeAction({
      toolCallId: "tc-int",
      action: { action: "left_click", coordinate: [640, 400] },
    });

    expect(result.widgetToolCalls.length).toBe(1);
    expect(result.widgetToolCalls[0]).toMatchObject({ name: "reserve", ok: true });
    expect(result.screenshotBase64 && result.screenshotBase64.length).toBeGreaterThan(
      0,
    );
    // dispatched through the injected callTool with the widget's serverId.
    expect(h.calls).toEqual([{ name: "reserve", args: { seat: 12 } }]);
  }, 30_000);

  it("returns 'no rendered widget' when acting on an unmounted tool call", async () => {
    const h = makeHarness();
    // Launch via a cheap render so the page exists, but don't keep it mounted.
    await h.renderWidget({
      toolCallId: "tc-gone",
      toolName: "show",
      serverId: "s1",
      html: blankHtml,
    });
    const result = await h.executeAction({
      toolCallId: "tc-gone",
      action: { action: "screenshot" },
    });
    expect(result.note).toBe("no rendered widget");
    expect(result.widgetToolCalls).toEqual([]);
  }, 30_000);
});
