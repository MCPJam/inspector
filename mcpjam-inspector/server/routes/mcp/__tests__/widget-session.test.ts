import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Hono } from "hono";
import {
  createMockMcpClientManager,
  createTestApp,
  type MockMCPClientManager,
} from "./helpers/index.js";
import { widgetRenderSessions } from "../../../services/widget-render-session";

/**
 * Route wiring for the interactive widget-session endpoints. The browser is
 * stubbed (fake McpAppBrowserHarness) and the registry singleton is swapped for
 * a small-cap instance, so start -> action -> close, the no-session verdicts,
 * the 429 cap, and 404 on a missing session are verified without a real browser.
 * The registry's own lifecycle (TTL, sweep, orphan cleanup) is covered in
 * services/__tests__/widget-render-session.test.ts.
 */

const harnessState = vi.hoisted(() => ({
  renderObservation: {
    status: "rendered",
    screenshotBase64: "cmVuZGVyZWQtc2hvdA==",
    bridgeInitialized: true,
  } as Record<string, unknown>,
  actionResult: {
    screenshotBase64: "YWN0aW9uLWZyYW1l",
    widgetToolCalls: [
      { name: "reserve", args: { seat: 12 }, ok: true, elapsedMs: 1 },
    ],
    elapsedMs: 3,
  } as Record<string, unknown>,
  disposeCalls: 0,
  /** When set, dispose() awaits it — lets a test hold a teardown open. */
  disposeGate: null as Promise<void> | null,
  reset() {
    this.renderObservation = {
      status: "rendered",
      screenshotBase64: "cmVuZGVyZWQtc2hvdA==",
      bridgeInitialized: true,
    };
    this.actionResult = {
      screenshotBase64: "YWN0aW9uLWZyYW1l",
      widgetToolCalls: [
        { name: "reserve", args: { seat: 12 }, ok: true, elapsedMs: 1 },
      ],
      elapsedMs: 3,
    };
    this.disposeCalls = 0;
    this.disposeGate = null;
  },
}));

vi.mock("../../../utils/mcp-app-browser-harness", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/mcp-app-browser-harness")
  >("../../../utils/mcp-app-browser-harness");
  class FakeHarness {
    async renderWidget(input: Record<string, unknown>) {
      return {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        serverId: input.serverId,
        resourceUri: input.resourceUri,
        elapsedMs: 5,
        ts: Date.now(),
        ...harnessState.renderObservation,
      };
    }
    async executeAction(input: { action: unknown }) {
      return { action: input.action, ...harnessState.actionResult };
    }
    async dispose() {
      harnessState.disposeCalls += 1;
      if (harnessState.disposeGate) await harnessState.disposeGate;
    }
  }
  return { ...actual, McpAppBrowserHarness: FakeHarness };
});

// Small-cap registry so the 429 path is cheap to exercise; no auto-sweep timer.
vi.mock("../../../services/widget-render-session", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/widget-render-session")
  >("../../../services/widget-render-session");
  return {
    ...actual,
    widgetRenderSessions: new actual.WidgetRenderSessionRegistry({
      maxSessions: 2,
      sweepIntervalMs: 0,
    }),
    wireWidgetSessionShutdown: () => {},
  };
});

const SERVER_ID = "test-server";
const TOOL_NAME = "show_seats";
const MCP_APP_META = { ui: { resourceUri: "ui://widget/seats" } };
const WIDGET_HTML = "<html><body>seats</body></html>";

function renderableManager(): MockMCPClientManager {
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
  });
}

async function startSession(
  app: Hono,
  body: Record<string, unknown> = { serverId: SERVER_ID, toolName: TOOL_NAME },
): Promise<Response> {
  return app.request("/api/mcp/widget-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("widget-session route", () => {
  let mcpClientManager: MockMCPClientManager;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    harnessState.reset();
    mcpClientManager = renderableManager();
    app = createTestApp(mcpClientManager, "widget-session");
  });

  afterEach(async () => {
    await widgetRenderSessions.disposeAll();
  });

  describe("start", () => {
    it("renders, registers a session, and returns the first frame", async () => {
      const res = await startSession(app);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.sessionId).toBeTruthy();
      expect(data.status).toBe("rendered");
      expect(data.screenshotBase64).toBe("cmVuZGVyZWQtc2hvdA==");
      expect(data.mountedWidgetId).toBeTruthy();
      expect(data.resourceUri).toBe("ui://widget/seats");
      expect(data.viewport).toEqual({ width: 1280, height: 800 });
      expect(typeof data.expiresAt).toBe("number");
      expect(typeof data.idleTimeoutMs).toBe("number");
      expect(widgetRenderSessions.size()).toBe(1);
    });

    it("honors a requested viewport", async () => {
      const res = await startSession(app, {
        serverId: SERVER_ID,
        toolName: TOOL_NAME,
        viewport: { width: 414, height: 896 },
      });
      expect((await res.json()).viewport).toEqual({ width: 414, height: 896 });
    });

    it("returns no_ui_resource with no session for a non-widget tool", async () => {
      mcpClientManager.listTools.mockResolvedValue({
        tools: [{ name: TOOL_NAME, _meta: { description: "plain" } }],
      });
      const res = await startSession(app);
      const data = await res.json();
      expect(data.status).toBe("no_ui_resource");
      expect(data.sessionId).toBeUndefined();
      expect(widgetRenderSessions.size()).toBe(0);
      // Gate-first: a non-widget tool must NOT be executed just to learn it has
      // no UI (guards against a gate-order regression).
      expect(mcpClientManager.executeTool).not.toHaveBeenCalled();
    });

    it("disposes and returns no session on a non-rendered verdict", async () => {
      harnessState.renderObservation = { status: "browser_unavailable" };
      const res = await startSession(app);
      const data = await res.json();
      expect(data.status).toBe("browser_unavailable");
      expect(data.hint).toBe("npx playwright install chromium");
      expect(data.sessionId).toBeUndefined();
      expect(harnessState.disposeCalls).toBe(1);
      expect(widgetRenderSessions.size()).toBe(0);
    });

    it("returns 400 when serverId is missing", async () => {
      const res = await startSession(app, { toolName: TOOL_NAME });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("serverId is required");
    });

    it("rejects with 429 when the session cap is reached", async () => {
      expect((await startSession(app)).status).toBe(200);
      expect((await startSession(app)).status).toBe(200);
      const third = await startSession(app);
      expect(third.status).toBe(429);
      expect((await third.json()).error).toMatch(/session limit reached/i);
      expect(widgetRenderSessions.size()).toBe(2);
    });

    it("holds the reserved slot until a non-rendered start's browser is disposed", async () => {
      // One of the two slots is a live session.
      expect((await startSession(app)).status).toBe(200);

      // A non-rendered start that still launched a browser, with a gated dispose.
      let finishDispose!: () => void;
      harnessState.disposeGate = new Promise<void>((resolve) => {
        finishDispose = resolve;
      });
      harnessState.renderObservation = { status: "browser_unavailable" };
      const disposingStart = startSession(app);

      // Let it reach the (parked) dispose.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harnessState.disposeCalls).toBe(1);

      // While that browser is still disposing, its slot must stay counted — a
      // concurrent start is rejected rather than allowed to exceed the cap.
      expect((await startSession(app)).status).toBe(429);

      // Finish disposal -> slot freed -> a start succeeds.
      finishDispose();
      harnessState.disposeGate = null;
      expect((await disposingStart).status).toBe(200);
      harnessState.renderObservation = {
        status: "rendered",
        screenshotBase64: "cmVuZGVyZWQtc2hvdA==",
        bridgeInitialized: true,
      };
      expect((await startSession(app)).status).toBe(200);
    });
  });

  describe("action", () => {
    async function startAndGetId(): Promise<string> {
      const data = await (await startSession(app)).json();
      return data.sessionId as string;
    }

    it("drives the mounted widget and returns the frame + tool calls", async () => {
      const sessionId = await startAndGetId();
      const res = await app.request(
        `/api/mcp/widget-session/${sessionId}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: { action: "left_click", coordinate: [10, 20] },
          }),
        },
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.action).toEqual({
        action: "left_click",
        coordinate: [10, 20],
      });
      expect(data.screenshotBase64).toBe("YWN0aW9uLWZyYW1l");
      expect(data.widgetToolCalls).toHaveLength(1);
      expect(data.widgetToolCalls[0].name).toBe("reserve");
      expect(typeof data.expiresAt).toBe("number");
    });

    it("returns 404 for an unknown session", async () => {
      const res = await app.request(
        "/api/mcp/widget-session/does-not-exist/action",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: { action: "screenshot" } }),
        },
      );
      expect(res.status).toBe(404);
    });

    it("returns 400 for a malformed action", async () => {
      const sessionId = await startAndGetId();
      for (const action of [
        { action: "teleport" },
        { action: "left_click", coordinate: [1] },
        { action: "scroll", scrollDirection: "diagonal" },
        // Negative/zero numeric flags are rejected server-side too (not just in
        // the CLI) — a negative duration must not reach page.waitForTimeout.
        { action: "scroll", scrollDirection: "down", scrollAmount: -5 },
        { action: "scroll", scrollDirection: "down", scrollAmount: 0 },
        { action: "wait", duration: -1 },
        {},
      ]) {
        const res = await app.request(
          `/api/mcp/widget-session/${sessionId}/action`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          },
        );
        expect(res.status, JSON.stringify(action)).toBe(400);
      }
    });
  });

  describe("close", () => {
    it("closes a live session and disposes its harness", async () => {
      const data = await (await startSession(app)).json();
      const res = await app.request(
        `/api/mcp/widget-session/${data.sessionId}`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(200);
      expect((await res.json()).closed).toBe(true);
      expect(harnessState.disposeCalls).toBe(1);
      expect(widgetRenderSessions.size()).toBe(0);
    });

    it("reports closed:false for an unknown session", async () => {
      const res = await app.request(
        "/api/mcp/widget-session/does-not-exist",
        { method: "DELETE" },
      );
      expect(res.status).toBe(200);
      expect((await res.json()).closed).toBe(false);
    });
  });
});
