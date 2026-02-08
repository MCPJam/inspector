import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import React from "react";

// Declare the global that Vite normally injects
(globalThis as any).__APP_VERSION__ = "0.0.0-test";

// ── Hoisted mocks ──────────────────────────────────────────────────────────
// vi.hoisted runs before imports, letting us capture bridge instances.
const { mockBridge, mockPostMessageTransport, triggerReady, stableStoreFns } =
  vi.hoisted(() => {
    const bridge = {
      sendToolInput: vi.fn(),
      sendToolResult: vi.fn(),
      sendToolCancelled: vi.fn(),
      setHostContext: vi.fn(),
      teardownResource: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      getAppCapabilities: vi.fn().mockReturnValue(undefined),
      // These callbacks get set by registerBridgeHandlers
      oninitialized: null as (() => void) | null,
      onmessage: null as any,
      onopenlink: null as any,
      oncalltool: null as any,
      onreadresource: null as any,
      onlistresources: null as any,
      onlistresourcetemplates: null as any,
      onlistprompts: null as any,
      onloggingmessage: null as any,
      onsizechange: null as any,
      onrequestdisplaymode: null as any,
      onupdatemodelcontext: null as any,
    };

    // Stable function references for store selectors — prevents useEffect deps
    // from changing on every render, which would teardown/reinitialize the bridge.
    const stableFns = {
      addLog: vi.fn(),
      setWidgetDebugInfo: vi.fn(),
      setWidgetGlobals: vi.fn(),
      setWidgetCsp: vi.fn(),
      addCspViolation: vi.fn(),
      clearCspViolations: vi.fn(),
      setWidgetModelContext: vi.fn(),
      setWidgetHtml: vi.fn(),
    };

    return {
      mockBridge: bridge,
      mockPostMessageTransport: vi.fn(),
      stableStoreFns: stableFns,
      /** Simulate the widget completing initialization. */
      triggerReady: () => {
        if (!bridge.oninitialized)
          throw new Error("oninitialized was never set on the bridge");
        bridge.oninitialized();
      },
    };
  });

// ── Module mocks ───────────────────────────────────────────────────────────
vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({
  AppBridge: vi.fn().mockImplementation(() => mockBridge),
  PostMessageTransport: mockPostMessageTransport,
}));

// Mock SandboxedIframe using forwardRef so the parent's useRef gets populated
vi.mock("@/components/ui/sandboxed-iframe", () => ({
  SandboxedIframe: React.forwardRef((_props: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      getIframeElement: () => ({
        contentWindow: { postMessage: vi.fn() },
        offsetHeight: 400,
        style: {},
        animate: vi.fn(),
      }),
    }));
    return <div data-testid="sandboxed-iframe" />;
  }),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => "light",
}));

vi.mock("@/stores/ui-playground-store", () => ({
  useUIPlaygroundStore: (selector: any) =>
    selector({
      isPlaygroundActive: false,
      mcpAppsCspMode: "permissive",
      globals: { locale: "en-US", timeZone: "UTC" },
      displayMode: "inline",
      capabilities: { hover: true, touch: false },
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      deviceType: "desktop",
    }),
}));

vi.mock("@/stores/traffic-log-store", () => ({
  useTrafficLogStore: (selector: any) =>
    selector({ addLog: stableStoreFns.addLog }),
  extractMethod: vi.fn(),
}));

vi.mock("@/stores/widget-debug-store", () => ({
  useWidgetDebugStore: (selector: any) =>
    selector({
      setWidgetDebugInfo: stableStoreFns.setWidgetDebugInfo,
      setWidgetGlobals: stableStoreFns.setWidgetGlobals,
      setWidgetCsp: stableStoreFns.setWidgetCsp,
      addCspViolation: stableStoreFns.addCspViolation,
      clearCspViolations: stableStoreFns.clearCspViolations,
      setWidgetModelContext: stableStoreFns.setWidgetModelContext,
      setWidgetHtml: stableStoreFns.setWidgetHtml,
    }),
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi
    .fn()
    .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
}));

vi.mock("../mcp-apps-renderer-helper", () => ({
  getMcpAppsStyleVariables: () => ({}),
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  isVisibleToModelOnly: () => false,
}));

vi.mock("lucide-react", () => ({
  X: (props: any) => <div {...props} />,
}));

// ── Import component under test (after mocks) ─────────────────────────────
import { MCPAppsRenderer } from "../mcp-apps-renderer";

// ── Helpers ────────────────────────────────────────────────────────────────
const baseProps = {
  serverId: "server-1",
  toolCallId: "call-1",
  toolName: "test-tool",
  toolState: "output-available" as const,
  toolInput: { elements: '[{"type":"rectangle"}]' },
  toolOutput: { content: [{ type: "text" as const, text: "ok" }] },
  resourceUri: "mcp-app://test",
};

// ── Tests ──────────────────────────────────────────────────────────────────
describe("MCPAppsRenderer tool input/output re-sending", () => {
  beforeEach(() => {
    // Reset all mock state between tests
    vi.clearAllMocks();
    mockBridge.sendToolInput.mockClear();
    mockBridge.sendToolResult.mockClear();
    mockBridge.sendToolCancelled.mockClear();
    mockBridge.connect.mockClear().mockResolvedValue(undefined);
    mockBridge.setHostContext.mockClear();
    mockBridge.close.mockClear().mockResolvedValue(undefined);
    mockBridge.teardownResource.mockClear().mockResolvedValue({});
    mockBridge.oninitialized = null;

    // Override global fetch to return real HTML for the cached URL fetch
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("<html><body>widget</body></html>"),
      json: () => Promise.resolve({}),
      status: 200,
      headers: new Headers(),
    } as Response);
  });

  it("sends tool input when widget becomes ready", async () => {
    render(
      <MCPAppsRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />,
    );

    // Wait for fetch + bridge.connect
    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    // Simulate widget ready
    act(() => triggerReady());

    await vi.waitFor(() => {
      expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(1);
      expect(mockBridge.sendToolInput).toHaveBeenCalledWith({
        arguments: baseProps.toolInput,
      });
    });
  });

  it("re-sends tool input when prop changes", async () => {
    const { rerender } = render(
      <MCPAppsRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    act(() => triggerReady());
    await vi.waitFor(() => {
      expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(1);
    });

    // Change tool input
    const newInput = { elements: '[{"type":"ellipse"}]' };
    rerender(
      <MCPAppsRenderer
        {...baseProps}
        toolInput={newInput}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(2);
      expect(mockBridge.sendToolInput).toHaveBeenLastCalledWith({
        arguments: newInput,
      });
    });
  });

  it("does not re-send tool input if value is unchanged", async () => {
    const { rerender } = render(
      <MCPAppsRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    act(() => triggerReady());
    await vi.waitFor(() => {
      expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(1);
    });

    // Rerender with a new reference but same serialized value
    rerender(
      <MCPAppsRenderer
        {...baseProps}
        toolInput={{ ...baseProps.toolInput }}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    // Should still be 1 — dedup prevents re-send
    expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(1);
  });

  it("sends tool output when widget becomes ready", async () => {
    render(
      <MCPAppsRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    act(() => triggerReady());

    await vi.waitFor(() => {
      expect(mockBridge.sendToolResult).toHaveBeenCalledTimes(1);
      expect(mockBridge.sendToolResult).toHaveBeenCalledWith(
        baseProps.toolOutput,
      );
    });
  });

  it("re-sends tool output when prop changes", async () => {
    const { rerender } = render(
      <MCPAppsRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    act(() => triggerReady());
    await vi.waitFor(() => {
      expect(mockBridge.sendToolResult).toHaveBeenCalledTimes(1);
    });

    // Change tool output
    const newOutput = { content: [{ type: "text" as const, text: "updated" }] };
    rerender(
      <MCPAppsRenderer
        {...baseProps}
        toolOutput={newOutput}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.sendToolResult).toHaveBeenCalledTimes(2);
      expect(mockBridge.sendToolResult).toHaveBeenLastCalledWith(newOutput);
    });
  });
});
