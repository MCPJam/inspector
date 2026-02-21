import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import React from "react";

// Declare the global that Vite normally injects
(globalThis as any).__APP_VERSION__ = "0.0.0-test";

// ── Hoisted mocks ──────────────────────────────────────────────────────────
// vi.hoisted runs before imports, letting us capture bridge instances.
const {
  mockBridge,
  mockPostMessageTransport,
  triggerReady,
  stableStoreFns,
  mockSandboxPostMessage,
  sandboxedIframePropsRef,
} = vi.hoisted(() => {
  const bridge = {
    sendToolInput: vi.fn(),
    sendToolInputPartial: vi.fn(),
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
    mockSandboxPostMessage: vi.fn(),
    sandboxedIframePropsRef: { current: null as any },
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
  SandboxedIframe: React.forwardRef((props: any, ref: any) => {
    sandboxedIframePropsRef.current = props;
    const iframeElementRef = React.useRef<HTMLElement | null>(null);
    if (!iframeElementRef.current) {
      const el = document.createElement("div");
      Object.defineProperty(el, "contentWindow", {
        value: { postMessage: mockSandboxPostMessage },
      });
      Object.defineProperty(el, "offsetHeight", { value: 400 });
      (el as HTMLElement & { animate: ReturnType<typeof vi.fn> }).animate =
        vi.fn();
      iframeElementRef.current = el;
    }

    React.useImperativeHandle(ref, () => ({
      getIframeElement: () => iframeElementRef.current,
      postMessage: (message: unknown) => {
        mockSandboxPostMessage(message);
      },
    }));
    return (
      <div
        data-testid="sandboxed-iframe"
        className={props.className}
        style={props.style}
      />
    );
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

vi.mock("../mcp-apps-modal", () => ({
  McpAppsModal: () => null,
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
describe("MCPAppsRenderer tool input streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge.sendToolInput.mockClear();
    mockBridge.sendToolInputPartial.mockClear();
    mockBridge.sendToolResult.mockClear();
    mockBridge.sendToolCancelled.mockClear();
    mockBridge.connect.mockClear().mockResolvedValue(undefined);
    mockBridge.setHostContext.mockClear();
    mockBridge.close.mockClear().mockResolvedValue(undefined);
    mockBridge.teardownResource.mockClear().mockResolvedValue({});
    mockBridge.oninitialized = null;
    mockSandboxPostMessage.mockClear();
    sandboxedIframePropsRef.current = null;

    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("<html><body>widget</body></html>"),
      json: () => Promise.resolve({}),
      status: 200,
      headers: new Headers(),
    } as Response);
  });

  it("sends partial tool input during input-streaming", async () => {
    const partialInput = { elements: '[{"type":"rectangle"' };
    render(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-streaming"
        toolInput={partialInput}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    act(() => triggerReady());

    await vi.waitFor(() => {
      expect(mockBridge.sendToolInputPartial).toHaveBeenCalledTimes(1);
      expect(mockBridge.sendToolInputPartial).toHaveBeenCalledWith({
        arguments: partialInput,
      });
    });
    expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(0);
  });

  it("keeps iframe hidden until first tool input chunk is delivered", async () => {
    const { rerender } = render(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-streaming"
        toolInput={undefined}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    act(() => triggerReady());
    act(() => {
      mockBridge.onsizechange?.({ width: 400, height: 300 });
    });

    expect(
      (screen.getByTestId("sandboxed-iframe") as HTMLElement).style.visibility,
    ).toBe("hidden");
    expect(screen.getByText("Streaming tool arguments...")).toBeTruthy();

    const partialInput = { elements: '[{"type":"rectangle"' };
    rerender(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-streaming"
        toolInput={partialInput}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.sendToolInputPartial).toHaveBeenCalledWith({
        arguments: partialInput,
      });
    });
    await vi.waitFor(() => {
      expect(
        (screen.getByTestId("sandboxed-iframe") as HTMLElement).style
          .visibility,
      ).toBe("");
    });
    expect(screen.queryByText("Streaming tool arguments...")).toBeNull();
  });

  it("streams updated partial input values while still streaming", async () => {
    const firstPartial = { elements: '[{"type":"rectangle"' };
    const secondPartial = {
      elements: '[{"type":"rectangle"},{"type":"ellipse"',
    };
    const { rerender } = render(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-streaming"
        toolInput={firstPartial}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    act(() => triggerReady());
    await vi.waitFor(() => {
      expect(mockBridge.sendToolInputPartial).toHaveBeenCalledTimes(1);
    });

    rerender(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-streaming"
        toolInput={secondPartial}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );
    await vi.waitFor(() => {
      expect(mockBridge.sendToolInputPartial).toHaveBeenCalledTimes(2);
      expect(mockBridge.sendToolInputPartial).toHaveBeenLastCalledWith({
        arguments: secondPartial,
      });
    });

    rerender(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-streaming"
        toolInput={{ ...secondPartial }}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );
    expect(mockBridge.sendToolInputPartial).toHaveBeenCalledTimes(2);
  });

  it("streams partial input when nested object values change with same keys", async () => {
    const firstPartial = { config: { width: 100, height: 200 } };
    const secondPartial = { config: { width: 500, height: 200 } };
    const { rerender } = render(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-streaming"
        toolInput={firstPartial}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    act(() => triggerReady());
    await vi.waitFor(() => {
      expect(mockBridge.sendToolInputPartial).toHaveBeenCalledTimes(1);
      expect(mockBridge.sendToolInputPartial).toHaveBeenCalledWith({
        arguments: firstPartial,
      });
    });

    rerender(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-streaming"
        toolInput={secondPartial}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.sendToolInputPartial).toHaveBeenCalledTimes(2);
      expect(mockBridge.sendToolInputPartial).toHaveBeenLastCalledWith({
        arguments: secondPartial,
      });
    });
  });

  it("streams partial input when same-length primitive arrays change", async () => {
    const firstPartial = { points: [1, 2, 3] };
    const secondPartial = { points: [1, 9, 3] };
    const { rerender } = render(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-streaming"
        toolInput={firstPartial}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    act(() => triggerReady());
    await vi.waitFor(() => {
      expect(mockBridge.sendToolInputPartial).toHaveBeenCalledTimes(1);
      expect(mockBridge.sendToolInputPartial).toHaveBeenCalledWith({
        arguments: firstPartial,
      });
    });

    rerender(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-streaming"
        toolInput={secondPartial}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.sendToolInputPartial).toHaveBeenCalledTimes(2);
      expect(mockBridge.sendToolInputPartial).toHaveBeenLastCalledWith({
        arguments: secondPartial,
      });
    });
  });

  it("resumes partial input when tool state restarts streaming for same toolCallId", async () => {
    const { rerender } = render(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-streaming"
        toolInput={{ elements: '[{"type":"rectangle"' }}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    act(() => triggerReady());
    await vi.waitFor(() => {
      expect(mockBridge.sendToolInputPartial).toHaveBeenCalledTimes(1);
    });

    const completeInput = { elements: '[{"type":"rectangle"}]' };
    rerender(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-available"
        toolInput={completeInput}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );
    await vi.waitFor(() => {
      expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(1);
      expect(mockBridge.sendToolInput).toHaveBeenCalledWith({
        arguments: completeInput,
      });
    });

    rerender(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-streaming"
        toolInput={{ elements: '[{"type":"triangle"' }}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );
    await vi.waitFor(() => {
      expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(1);
      expect(mockBridge.sendToolInputPartial).toHaveBeenCalledTimes(2);
    });

    rerender(
      <MCPAppsRenderer
        {...baseProps}
        toolState="output-available"
        toolInput={{ elements: '[{"type":"ellipse"}]' }}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );
    await vi.waitFor(() => {
      expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(2);
    });
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

  it("re-sends complete tool input when input changes in output-available", async () => {
    const { rerender } = render(
      <MCPAppsRenderer
        {...baseProps}
        toolState="output-available"
        toolInput={{ elements: '[{"type":"rectangle"}]' }}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    act(() => triggerReady());

    await vi.waitFor(() => {
      expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(1);
      expect(mockBridge.sendToolInput).toHaveBeenCalledWith({
        arguments: { elements: '[{"type":"rectangle"}]' },
      });
    });

    rerender(
      <MCPAppsRenderer
        {...baseProps}
        toolState="output-available"
        toolInput={{ elements: '[{"type":"ellipse"}]' }}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(2);
      expect(mockBridge.sendToolInput).toHaveBeenLastCalledWith({
        arguments: { elements: '[{"type":"ellipse"}]' },
      });
    });
  });

  it("rejects invalid fileId in getFileDownloadUrl widget messages", async () => {
    render(
      <MCPAppsRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
      expect(sandboxedIframePropsRef.current?.onMessage).toBeTypeOf("function");
    });

    act(() => {
      sandboxedIframePropsRef.current.onMessage({
        data: {
          type: "openai:getFileDownloadUrl",
          callId: 42,
          fileId: "../../other-endpoint",
        },
      } as MessageEvent);
    });

    expect(mockSandboxPostMessage).toHaveBeenCalledWith({
      type: "openai:getFileDownloadUrl:response",
      callId: 42,
      error: "Invalid fileId",
    });
  });

  it("hides MCP app resource URI metadata row in minimal mode", async () => {
    render(
      <MCPAppsRenderer
        {...baseProps}
        minimalMode={true}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(screen.queryByText("MCP App:")).toBeNull();
    expect(screen.queryByText(baseProps.resourceUri)).toBeNull();
  });

  it("suppresses bridge diagnostic logs in minimal mode", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <MCPAppsRenderer
        {...baseProps}
        minimalMode={true}
        cachedWidgetHtmlUrl="blob:cached"
      />,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    act(() => {
      mockBridge.onloggingmessage?.({
        level: "info",
        data: { message: "hello" },
        logger: "widget",
      });
      mockBridge.onloggingmessage?.({
        level: "warning",
        data: { message: "warn" },
        logger: "widget",
      });
      mockBridge.onloggingmessage?.({
        level: "error",
        data: { message: "err" },
        logger: "widget",
      });
    });

    const hasMcpAppsLog = (calls: unknown[][]) =>
      calls.some((call) => String(call[0] ?? "").includes("[MCP Apps]"));

    expect(hasMcpAppsLog(infoSpy.mock.calls)).toBe(false);
    expect(hasMcpAppsLog(warnSpy.mock.calls)).toBe(false);
    expect(hasMcpAppsLog(errorSpy.mock.calls)).toBe(false);

    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
