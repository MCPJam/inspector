import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Hono } from "hono";
import {
  createMockMcpClientManager,
  createTestApp,
  type MockMCPClientManager,
} from "./helpers/index.js";

/**
 * widget-render.test.ts — route wiring for POST /api/mcp/widget-render.
 *
 * The actual headless render is exercised against real Chromium in
 * widget-render.integration.test.ts and in the harness/observation suites; here
 * the browser is stubbed (a fake `McpAppBrowserHarness`) so the route's logic —
 * validation, the executeTool → metadata gate → harness → response mapping
 * pipeline, the `browser_unavailable` hint, viewport forwarding, and
 * always-dispose — is verified deterministically without a browser.
 */

// Shared, hoisted state the fake harness writes to and tests read/configure.
const harnessState = vi.hoisted(() => ({
  constructorOpts: [] as Array<Record<string, unknown>>,
  renderInputs: [] as Array<Record<string, unknown>>,
  disposeCalls: 0,
  // Per-test overrides spread onto the returned observation.
  nextObservation: {
    status: "rendered",
    screenshotBase64: "ZmFrZS1zY3JlZW5zaG90",
  } as Record<string, unknown>,
  reset() {
    this.constructorOpts = [];
    this.renderInputs = [];
    this.disposeCalls = 0;
    this.nextObservation = {
      status: "rendered",
      screenshotBase64: "ZmFrZS1zY3JlZW5zaG90",
    };
  },
}));

vi.mock("../../../utils/mcp-app-browser-harness", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/mcp-app-browser-harness")
  >("../../../utils/mcp-app-browser-harness");

  // Stand-in for McpAppBrowserHarness: records its construction args + the
  // render input `renderMcpAppToolResult` hands it, and returns a configurable
  // observation. ChromiumNotInstalledError (also imported by the route) stays
  // real via the `...actual` spread.
  class FakeHarness {
    constructor(opts: Record<string, unknown>) {
      harnessState.constructorOpts.push(opts);
    }
    async renderWidget(input: Record<string, unknown>) {
      harnessState.renderInputs.push(input);
      return {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        serverId: input.serverId,
        resourceUri: input.resourceUri,
        elapsedMs: 7,
        ts: Date.now(),
        ...harnessState.nextObservation,
      };
    }
    async dispose() {
      harnessState.disposeCalls += 1;
    }
  }

  return { ...actual, McpAppBrowserHarness: FakeHarness };
});

const SERVER_ID = "test-server";
const TOOL_NAME = "show_seats";
const MCP_APP_META = { ui: { resourceUri: "ui://widget/seats" } };
const WIDGET_HTML = "<html><body>seats</body></html>";

function renderableManager(
  overrides: Parameters<typeof createMockMcpClientManager>[0] = {},
): MockMCPClientManager {
  return createMockMcpClientManager({
    // The gate resolves renderability from each tools/list page's `_meta`
    // directly (the manager's metadata cache only retains the last page).
    listTools: vi
      .fn()
      .mockResolvedValue({ tools: [{ name: TOOL_NAME, _meta: MCP_APP_META }] }),
    getAllToolsMetadata: vi.fn().mockReturnValue({ [TOOL_NAME]: MCP_APP_META }),
    readResource: vi.fn().mockResolvedValue({
      contents: [{ text: WIDGET_HTML, _meta: { ui: {} } }],
    }),
    ...overrides,
  });
}

async function postRender(
  app: Hono,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request("/api/mcp/widget-render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/mcp/widget-render", () => {
  let mcpClientManager: MockMCPClientManager;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    harnessState.reset();
    mcpClientManager = renderableManager();
    app = createTestApp(mcpClientManager, "widget-render");
  });

  describe("validation", () => {
    it("returns 400 when serverId is missing", async () => {
      const res = await postRender(app, { toolName: TOOL_NAME });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("serverId is required");
      expect(mcpClientManager.executeTool).not.toHaveBeenCalled();
    });

    it("returns 400 when toolName is missing", async () => {
      const res = await postRender(app, { serverId: SERVER_ID });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("toolName is required");
    });

    it("returns 400 on invalid JSON", async () => {
      const res = await app.request("/api/mcp/widget-render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when parameters is not a plain object", async () => {
      for (const parameters of [[1, 2, 3], "nope", 42, true]) {
        const res = await postRender(app, {
          serverId: SERVER_ID,
          toolName: TOOL_NAME,
          parameters,
        });
        expect(res.status, JSON.stringify(parameters)).toBe(400);
        expect((await res.json()).error).toBe("parameters must be a JSON object");
      }
      // Missing parameters defaults to {} (no error).
      const ok = await postRender(app, {
        serverId: SERVER_ID,
        toolName: TOOL_NAME,
      });
      expect(ok.status).toBe(200);
      expect(mcpClientManager.executeTool).toHaveBeenLastCalledWith(
        SERVER_ID,
        TOOL_NAME,
        {},
      );
    });

    it("returns 400 when viewport is malformed", async () => {
      for (const viewport of [
        { width: 0, height: 600 },
        { width: 800, height: -1 },
        { width: 800.5, height: 600 },
        { width: "800", height: 600 },
        { width: 800 },
        [800, 600],
      ]) {
        const res = await postRender(app, {
          serverId: SERVER_ID,
          toolName: TOOL_NAME,
          viewport,
        });
        expect(res.status, JSON.stringify(viewport)).toBe(400);
      }
      expect(harnessState.constructorOpts).toHaveLength(0);
    });
  });

  describe("tool execution", () => {
    it("returns 500 when executeTool throws", async () => {
      mcpClientManager.executeTool.mockRejectedValueOnce(
        new Error("server not connected"),
      );
      const res = await postRender(app, {
        serverId: SERVER_ID,
        toolName: TOOL_NAME,
      });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("server not connected");
      // No widget to render -> harness never constructed.
      expect(harnessState.constructorOpts).toHaveLength(0);
    });

    it("returns 500 when listing tools fails", async () => {
      mcpClientManager.listTools.mockRejectedValueOnce(
        new Error("server disconnected"),
      );
      const res = await postRender(app, {
        serverId: SERVER_ID,
        toolName: TOOL_NAME,
      });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("server disconnected");
      // Can't determine renderability -> tool not executed, harness not built.
      expect(mcpClientManager.executeTool).not.toHaveBeenCalled();
      expect(harnessState.constructorOpts).toHaveLength(0);
    });
  });

  describe("renderability gate", () => {
    it("returns no_ui_resource WITHOUT executing the tool (gate-first)", async () => {
      // A listed tool with no UI resource in its `_meta` is not renderable.
      mcpClientManager.listTools.mockResolvedValue({
        tools: [{ name: TOOL_NAME, _meta: { description: "plain tool" } }],
      });
      const res = await postRender(app, {
        serverId: SERVER_ID,
        toolName: TOOL_NAME,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("no_ui_resource");
      expect(data.screenshotBase64).toBeUndefined();
      expect(harnessState.constructorOpts).toHaveLength(0);
      // Gate-first: a non-widget tool must NOT be run just to learn it has no
      // UI. Tools are listed (to resolve metadata); the tool is not executed.
      expect(mcpClientManager.listTools).toHaveBeenCalledWith(SERVER_ID, undefined);
      expect(mcpClientManager.executeTool).not.toHaveBeenCalled();
    });

    it("reads the tool's _meta from the awaited listTools result", async () => {
      // The gate resolves renderability from the listTools RESULT, so it must
      // await it — proving it doesn't rely on a pre-warmed metadata cache
      // (connect doesn't list tools, and executeTool doesn't cache metadata).
      let resolved = false;
      mcpClientManager.listTools.mockImplementation(
        () =>
          new Promise((resolve) => {
            queueMicrotask(() => {
              resolved = true;
              resolve({ tools: [{ name: TOOL_NAME, _meta: MCP_APP_META }] });
            });
          }),
      );
      const res = await postRender(app, {
        serverId: SERVER_ID,
        toolName: TOOL_NAME,
      });
      expect(resolved).toBe(true);
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("rendered");
      expect(mcpClientManager.listTools).toHaveBeenCalledWith(SERVER_ID, undefined);
      expect(mcpClientManager.executeTool).toHaveBeenCalledTimes(1);
    });

    it("finds a renderable tool on a later tools/list page", async () => {
      // Regression: the gate must DRAIN pages, not read only page 1 — the
      // manager's metadata cache is replaced per page, so a renderable tool on
      // page 2+ would otherwise be reported no_ui_resource and never render.
      mcpClientManager.listTools.mockImplementation(
        async (_serverId: string, params?: { cursor?: string }) => {
          if (!params?.cursor) {
            return {
              tools: [{ name: "other_tool", _meta: {} }],
              nextCursor: "page-2",
            };
          }
          return {
            tools: [{ name: TOOL_NAME, _meta: MCP_APP_META }],
            nextCursor: undefined,
          };
        },
      );
      const res = await postRender(app, {
        serverId: SERVER_ID,
        toolName: TOOL_NAME,
      });
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("rendered");
      expect(mcpClientManager.listTools).toHaveBeenCalledTimes(2);
      expect(mcpClientManager.listTools).toHaveBeenLastCalledWith(SERVER_ID, {
        cursor: "page-2",
      });
      expect(mcpClientManager.executeTool).toHaveBeenCalledTimes(1);
    });

    it("returns no_ui_resource after draining every page without the tool", async () => {
      mcpClientManager.listTools.mockImplementation(
        async (_serverId: string, params?: { cursor?: string }) => {
          if (!params?.cursor) {
            return { tools: [{ name: "a", _meta: {} }], nextCursor: "page-2" };
          }
          return { tools: [{ name: "b", _meta: {} }], nextCursor: undefined };
        },
      );
      const res = await postRender(app, {
        serverId: SERVER_ID,
        toolName: TOOL_NAME,
      });
      expect((await res.json()).status).toBe("no_ui_resource");
      expect(mcpClientManager.listTools).toHaveBeenCalledTimes(2);
      expect(mcpClientManager.executeTool).not.toHaveBeenCalled();
    });

    it("stops draining if the server loops the same cursor", async () => {
      // A server that returns the same cursor forever must not hang the gate.
      mcpClientManager.listTools.mockResolvedValue({
        tools: [{ name: "x", _meta: {} }],
        nextCursor: "same",
      });
      const res = await postRender(app, {
        serverId: SERVER_ID,
        toolName: TOOL_NAME,
      });
      expect((await res.json()).status).toBe("no_ui_resource");
      expect(mcpClientManager.listTools).toHaveBeenCalledTimes(2);
    });
  });

  describe("render", () => {
    it("renders a renderable widget and returns the screenshot + verdict", async () => {
      harnessState.nextObservation = {
        status: "rendered",
        screenshotBase64: "aVZCT1J3MEtHZ29B",
        bridgeInitialized: true,
        consoleErrors: ["a warning"],
        blockedRequests: ["https://blocked.example"],
      };
      const res = await postRender(app, {
        serverId: SERVER_ID,
        toolName: TOOL_NAME,
        parameters: { seat: 12 },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("rendered");
      expect(data.screenshotBase64).toBe("aVZCT1J3MEtHZ29B");
      expect(data.resourceUri).toBe("ui://widget/seats");
      expect(data.bridgeInitialized).toBe(true);
      expect(data.consoleErrors).toEqual(["a warning"]);
      expect(data.blockedRequests).toEqual(["https://blocked.example"]);
      expect(typeof data.elapsedMs).toBe("number");
      expect(data.hint).toBeUndefined();

      expect(mcpClientManager.executeTool).toHaveBeenCalledWith(
        SERVER_ID,
        TOOL_NAME,
        { seat: 12 },
      );
      // Always disposes the harness, even on the happy path.
      expect(harnessState.disposeCalls).toBe(1);
    });

    it("forwards the requested viewport to the harness", async () => {
      await postRender(app, {
        serverId: SERVER_ID,
        toolName: TOOL_NAME,
        viewport: { width: 414, height: 896 },
      });
      expect(harnessState.constructorOpts[0]?.viewport).toEqual({
        width: 414,
        height: 896,
      });
    });

    it("omits viewport from harness options when not requested", async () => {
      await postRender(app, { serverId: SERVER_ID, toolName: TOOL_NAME });
      expect(harnessState.constructorOpts[0]?.viewport).toBeUndefined();
    });

    it("injects the OpenAI compat shim into the widget HTML when requested", async () => {
      await postRender(app, {
        serverId: SERVER_ID,
        toolName: TOOL_NAME,
        injectOpenAiCompat: true,
      });
      const html = harnessState.renderInputs[0]?.html as string;
      // The shim defines the window.openai surface, growing the HTML.
      expect(html).not.toBe(WIDGET_HTML);
      expect(html).toContain("openai");
    });

    it("passes the raw widget HTML through when the shim is off", async () => {
      await postRender(app, { serverId: SERVER_ID, toolName: TOOL_NAME });
      expect(harnessState.renderInputs[0]?.html).toBe(WIDGET_HTML);
    });
  });

  describe("browser_unavailable", () => {
    it("maps a browser_unavailable observation to an install hint", async () => {
      harnessState.nextObservation = { status: "browser_unavailable" };
      const res = await postRender(app, {
        serverId: SERVER_ID,
        toolName: TOOL_NAME,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("browser_unavailable");
      expect(data.hint).toBe("npx playwright install chromium");
      expect(data.screenshotBase64).toBeUndefined();
      expect(harnessState.disposeCalls).toBe(1);
    });
  });
});
