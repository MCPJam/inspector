import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import React from "react";
import {
  CHATGPT_HOST_STYLE,
  CLAUDE_HOST_STYLE,
  getHostCapabilitiesForStyle,
} from "@/lib/client-styles";

// Declare the global that Vite normally injects
(globalThis as any).__APP_VERSION__ = "0.0.0-test";

// ── Hoisted mocks ──────────────────────────────────────────────────────────
// vi.hoisted runs before imports, letting us capture bridge instances.
const {
  mockBridge,
  mockAppBridgeCtor,
  mockPostMessageTransport,
  triggerReady,
  stableStoreFns,
  mockSandboxPostMessage,
  sandboxedIframePropsRef,
  sandboxedIframeElementRef,
  sandboxedIframeMountsRef,
  sandboxedIframeUnmountsRef,
  sandboxProxyBehaviorRef,
  appBridgeArgsRef,
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
    onrequestteardown: null as any,
  };
  const appBridgeArgsRef = { current: null as any };
  const mockAppBridgeCtor = vi
    .fn()
    .mockImplementation((client, hostInfo, hostCapabilities, options) => {
      appBridgeArgsRef.current = {
        client,
        hostInfo,
        hostCapabilities,
        options,
      };
      return bridge;
    });
  const sandboxedIframeElementRef = { current: null as HTMLElement | null };
  const sandboxedIframeMountsRef = { current: 0 };
  const sandboxedIframeUnmountsRef = { current: 0 };

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
    setSandboxApplied: vi.fn(),
    appendLifecycle: vi.fn(),
    recordMount: vi.fn(),
  };

  return {
    mockBridge: bridge,
    mockAppBridgeCtor,
    mockPostMessageTransport: vi.fn(),
    mockSandboxPostMessage: vi.fn(),
    sandboxedIframePropsRef: { current: null as any },
    sandboxedIframeElementRef,
    sandboxedIframeMountsRef,
    sandboxedIframeUnmountsRef,
    sandboxProxyBehaviorRef: { current: { autoReady: true } },
    appBridgeArgsRef,
    stableStoreFns: stableFns,
    /** Simulate the widget completing initialization. */
    triggerReady: () => {
      if (!bridge.oninitialized)
        throw new Error("oninitialized was never set on the bridge");
      bridge.oninitialized();
    },
  };
});

const mockHostContextStoreState = {
  draftHostContext: {} as Record<string, unknown>,
};

const mockPreferencesState: {
  themeMode: "light" | "dark";
  hostStyle: "claude" | "chatgpt";
} = {
  themeMode: "light",
  hostStyle: "claude",
};

const mockPlaygroundStoreState = {
  isPlaygroundActive: false,
  mcpAppsCspMode: "permissive" as const,
  globals: { locale: "en-US", timeZone: "UTC" },
  displayMode: "inline" as const,
  capabilities: { hover: true, touch: false },
  safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  deviceType: "desktop" as const,
};

// ── Module mocks ───────────────────────────────────────────────────────────
vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({
  AppBridge: mockAppBridgeCtor,
  PostMessageTransport: mockPostMessageTransport,
}));

// Mock SandboxedIframe using forwardRef so the parent's useRef gets populated
vi.mock("@/components/ui/sandboxed-iframe", () => ({
  SandboxedIframe: React.forwardRef((props: any, ref: any) => {
    sandboxedIframePropsRef.current = props;
    const iframeElementRef = React.useRef<HTMLElement | null>(null);
    React.useEffect(() => {
      sandboxedIframeMountsRef.current += 1;
      return () => {
        sandboxedIframeUnmountsRef.current += 1;
      };
    }, []);
    if (!iframeElementRef.current) {
      const el = document.createElement("div");
      Object.defineProperty(el, "contentWindow", {
        value: { postMessage: mockSandboxPostMessage },
      });
      Object.defineProperty(el, "offsetHeight", { value: 400 });
      const animatedEl = el as unknown as HTMLElement & {
        animate: ReturnType<typeof vi.fn>;
      };
      animatedEl.animate = vi.fn();
      iframeElementRef.current = el;
    }
    sandboxedIframeElementRef.current = iframeElementRef.current;

    React.useImperativeHandle(ref, () => ({
      getIframeElement: () => iframeElementRef.current,
      postMessage: (message: unknown) => {
        mockSandboxPostMessage(message);
      },
    }));
    React.useEffect(() => {
      if (!sandboxProxyBehaviorRef.current.autoReady) return;
      props.onProxyReady?.();
    }, [props.onProxyReady]);
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
  usePreferencesStore: (selector: any) =>
    selector ? selector(mockPreferencesState) : mockPreferencesState,
}));

vi.mock("@/stores/ui-playground-store", () => ({
  useUIPlaygroundStore: (selector: any) => selector(mockPlaygroundStoreState),
}));

vi.mock("@/stores/client-context-store", () => ({
  useHostContextStore: (selector: any) => selector(mockHostContextStoreState),
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
      setSandboxApplied: stableStoreFns.setSandboxApplied,
      appendLifecycle: stableStoreFns.appendLifecycle,
      recordMount: stableStoreFns.recordMount,
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
  UIType: {
    MCP_APPS: "mcp-apps",
    OPENAI_SDK: "openai-sdk",
    OPENAI_SDK_AND_MCP_APPS: "openai-sdk-and-mcp-apps",
  },
}));

vi.mock("lucide-react", () => ({
  X: (props: any) => <div {...props} />,
}));

// Capture props passed into the modal so tests can assert inline/modal
// HostCapabilities parity without mounting a real second AppBridge.
const mcpAppsModalPropsRef: { current: Record<string, unknown> | null } = {
  current: null,
};
vi.mock("../mcp-apps-modal", () => ({
  McpAppsModal: (props: Record<string, unknown>) => {
    mcpAppsModalPropsRef.current = props;
    return null;
  },
}));

// ── Import component under test (after mocks) ─────────────────────────────
import { MCPAppsRenderer } from "../mcp-apps-renderer";
import {
  WidgetSurfaceHost,
  WidgetSurfaceHostProvider,
} from "../widget-surface-host";
import { useWidgetSurfaceStore } from "../widget-surface-store";
import { authFetch } from "@/lib/session-token";
import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-client-style-context";
import { ChatboxHostCapabilitiesOverrideProvider } from "@/contexts/chatbox-client-capabilities-override-context";
import { ActiveMcpProfileProvider } from "@/contexts/active-mcp-profile-context";
import { WidgetSurfaceProvider } from "@/contexts/widget-surface-context";
import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { HostConfigMcpProfileV1 } from "@/lib/client-config-v2";

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

const createEquivalentMcpProfile = (): HostConfigMcpProfileV1 => ({
  profileVersion: 1,
  apps: {
    sandbox: {
      csp: {
        mode: "declared",
        restrictTo: {
          connectDomains: ["https://api.example.com"],
          resourceDomains: ["https://cdn.example.com"],
        },
      },
      permissions: {
        mode: "custom",
        allow: { camera: true },
      },
      sandboxAttrs: ["allow-popups"],
      allowFeatures: { fullscreen: "*" },
    },
    uiInitialize: {
      hostInfo: {
        name: "test-host",
        version: "1.0.0",
      },
    },
  },
});

// ── Tests ──────────────────────────────────────────────────────────────────
describe("MCPAppsRenderer tool input streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHostContextStoreState.draftHostContext = {};
    Object.assign(mockPreferencesState, {
      themeMode: "light",
      hostStyle: "claude",
    });
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: false,
      mcpAppsCspMode: "permissive",
      globals: { locale: "en-US", timeZone: "UTC" },
      displayMode: "inline",
      capabilities: { hover: true, touch: false },
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      deviceType: "desktop",
    });
    mockBridge.sendToolInput.mockClear();
    mockBridge.sendToolInputPartial.mockClear();
    mockBridge.sendToolResult.mockClear();
    mockBridge.sendToolCancelled.mockClear();
    mockBridge.connect.mockClear().mockResolvedValue(undefined);
    mockBridge.setHostContext.mockClear();
    mockBridge.close.mockClear().mockResolvedValue(undefined);
    mockBridge.teardownResource.mockClear().mockResolvedValue({});
    mockAppBridgeCtor.mockClear();
    mockBridge.oninitialized = null;
    mockBridge.onmessage = null;
    mockBridge.onopenlink = null;
    mockBridge.oncalltool = null;
    mockBridge.onreadresource = null;
    mockBridge.onlistresources = null;
    mockBridge.onlistresourcetemplates = null;
    mockBridge.onlistprompts = null;
    mockBridge.onloggingmessage = null;
    mockBridge.onsizechange = null;
    mockBridge.onrequestdisplaymode = null;
    mockBridge.onupdatemodelcontext = null;
    mockBridge.onrequestteardown = null;
    mockSandboxPostMessage.mockClear();
    sandboxedIframePropsRef.current = null;
    sandboxedIframeElementRef.current = null;
    sandboxedIframeMountsRef.current = 0;
    sandboxedIframeUnmountsRef.current = 0;
    sandboxProxyBehaviorRef.current.autoReady = true;
    appBridgeArgsRef.current = null;
    useWidgetSurfaceStore.setState({
      surfaces: new Map(),
      nextOrder: 0,
    });

    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("<html><body>widget</body></html>"),
      json: () => Promise.resolve({}),
      status: 200,
      headers: new Headers(),
    } as Response);

    vi.mocked(authFetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          html: "<html><body>live-widget</body></html>",
          csp: {
            connectDomains: ["https://api.example.com"],
            resourceDomains: ["https://cdn.example.com"],
            frameDomains: [],
            baseUriDomains: [],
          },
          permissions: { camera: true },
          permissive: false,
          mimeTypeValid: true,
          prefersBorder: true,
        }),
      status: 200,
      headers: new Headers(),
    } as Response);
  });

  it("forces permissive replay for cached HTML when widgetPermissive is missing", async () => {
    render(
      <MCPAppsRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        widgetCsp={{
          connectDomains: ["https://ignored.example.com"],
          resourceDomains: ["https://ignored.example.com"],
          frameDomains: [],
          baseUriDomains: [],
        }}
        widgetPermissions={{ microphone: true } as any}
      />
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>"
      );
    });

    expect(sandboxedIframePropsRef.current?.permissive).toBe(true);
    expect(sandboxedIframePropsRef.current?.csp).toBeUndefined();
    expect(sandboxedIframePropsRef.current?.permissions).toBeUndefined();
  });

  it("advertises hostCapabilities from the active host style preset (claude)", async () => {
    render(
      <ChatboxHostStyleProvider value="claude">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    // Should advertise Claude's preset, not the old empty literal.
    expect(appBridgeArgsRef.current?.hostCapabilities).toEqual(
      expect.objectContaining(getHostCapabilitiesForStyle("claude"))
    );
  });

  it("keeps the iframe and bridge alive when only the tool call id changes", async () => {
    const { rerender } = render(<MCPAppsRenderer {...baseProps} />);

    await vi.waitFor(() => {
      expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("sandboxed-iframe")).toBeInTheDocument();
    });

    expect(sandboxedIframeMountsRef.current).toBe(1);

    act(() => triggerReady());

    rerender(
      <MCPAppsRenderer
        {...baseProps}
        toolCallId="call-2"
        toolOutput={{ content: [{ type: "text" as const, text: "next" }] }}
      />
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId("sandboxed-iframe")).toBeInTheDocument();
    });

    expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
    expect(mockBridge.close).not.toHaveBeenCalled();
    expect(mockBridge.teardownResource).not.toHaveBeenCalled();
    expect(sandboxedIframeMountsRef.current).toBe(1);
    expect(sandboxedIframeUnmountsRef.current).toBe(0);
  });

  it("does not rebuild when the active MCP profile is recreated without semantic changes", async () => {
    const renderTree = () => (
      <ActiveMcpProfileProvider value={createEquivalentMcpProfile()}>
        <MCPAppsRenderer {...baseProps} />
      </ActiveMcpProfileProvider>
    );

    const { rerender } = render(renderTree());

    await vi.waitFor(() => {
      expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("sandboxed-iframe")).toBeInTheDocument();
    });

    act(() => triggerReady());

    rerender(renderTree());

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
    expect(mockBridge.close).not.toHaveBeenCalled();
    expect(mockBridge.teardownResource).not.toHaveBeenCalled();
    expect(sandboxedIframeMountsRef.current).toBe(1);
    expect(sandboxedIframeUnmountsRef.current).toBe(0);
  });

  it("does not rebuild when the host capabilities override is recreated without semantic changes", async () => {
    const renderTree = () => (
      <ChatboxHostCapabilitiesOverrideProvider
        value={{ openLinks: {}, logging: {}, serverTools: {} }}
      >
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostCapabilitiesOverrideProvider>
    );

    const { rerender } = render(renderTree());

    await vi.waitFor(() => {
      expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("sandboxed-iframe")).toBeInTheDocument();
    });

    act(() => triggerReady());

    rerender(renderTree());

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
    expect(mockBridge.close).not.toHaveBeenCalled();
    expect(mockBridge.teardownResource).not.toHaveBeenCalled();
    expect(sandboxedIframeMountsRef.current).toBe(1);
    expect(sandboxedIframeUnmountsRef.current).toBe(0);
  });

  it("shares one persistent surface across tool calls to the same widget", async () => {
    const firstOutput = { content: [{ type: "text" as const, text: "first" }] };
    const updatedFirstOutput = {
      content: [{ type: "text" as const, text: "first-rerendered" }],
    };
    const secondOutput = {
      content: [{ type: "text" as const, text: "second" }],
    };
    const renderTree = (
      includeSecondCall: boolean,
      currentFirstOutput = firstOutput
    ) => (
      <WidgetSurfaceHostProvider>
        <MCPAppsRenderer
          {...baseProps}
          toolCallId="call-1"
          toolInput={{ move: "e4" }}
          toolOutput={currentFirstOutput}
        />
        {includeSecondCall ? (
          <MCPAppsRenderer
            {...baseProps}
            toolCallId="call-2"
            toolInput={{ move: "c5" }}
            toolOutput={secondOutput}
          />
        ) : null}
        <WidgetSurfaceHost />
      </WidgetSurfaceHostProvider>
    );

    const { rerender } = render(renderTree(false));

    await vi.waitFor(() => {
      expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("sandboxed-iframe")).toBeInTheDocument();
    });
    const getSurfaceContainer = () =>
      document.querySelector("[data-mcp-app-surface-container]") as HTMLElement;
    expect(getSurfaceContainer().parentElement).toHaveAttribute(
      "data-mcp-app-surface-anchor",
      "call-1"
    );

    act(() => triggerReady());

    await vi.waitFor(() => {
      expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(1);
      expect(mockBridge.sendToolInput).toHaveBeenCalledWith({
        arguments: { move: "e4" },
      });
      expect(mockBridge.sendToolResult).toHaveBeenCalledTimes(1);
    });

    rerender(renderTree(true));

    await vi.waitFor(() => {
      expect(mockBridge.sendToolResult).toHaveBeenCalledTimes(2);
      expect(mockBridge.sendToolResult).toHaveBeenLastCalledWith(secondOutput);
    });

    rerender(renderTree(true, updatedFirstOutput));
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockBridge.sendToolResult).toHaveBeenCalledTimes(2);
    expect(mockBridge.sendToolResult).toHaveBeenLastCalledWith(secondOutput);
    expect(getSurfaceContainer().parentElement).toHaveAttribute(
      "data-mcp-app-surface-anchor",
      "call-1"
    );
    expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(1);
    expect(mockBridge.close).not.toHaveBeenCalled();
    expect(mockBridge.teardownResource).not.toHaveBeenCalled();
    expect(sandboxedIframeMountsRef.current).toBe(1);
    expect(sandboxedIframeUnmountsRef.current).toBe(0);
  });

  it("keeps live-preferred cached tool calls on one persistent resource surface", async () => {
    render(
      <WidgetSurfaceHostProvider>
        <MCPAppsRenderer
          {...baseProps}
          toolCallId="call-1"
          cachedWidgetHtmlUrl="blob:cached"
          liveFetchPreferred
        />
        <MCPAppsRenderer
          {...baseProps}
          toolCallId="call-2"
          cachedWidgetHtmlUrl="blob:cached"
          liveFetchPreferred
          toolOutput={{ content: [{ type: "text" as const, text: "next" }] }}
        />
        <WidgetSurfaceHost />
      </WidgetSurfaceHostProvider>
    );

    await vi.waitFor(() => {
      expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("sandboxed-iframe")).toBeInTheDocument();
    });

    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalledWith("blob:cached");
    expect(mockBridge.close).not.toHaveBeenCalled();
    expect(mockBridge.teardownResource).not.toHaveBeenCalled();
    expect(sandboxedIframeMountsRef.current).toBe(1);
    expect(sandboxedIframeUnmountsRef.current).toBe(0);
  });

  it("sends identical persistent surface results for different tool calls", async () => {
    const sameOutput = { content: [{ type: "text" as const, text: "same" }] };
    const renderTree = (toolCallId: string) => (
      <WidgetSurfaceHostProvider>
        <MCPAppsRenderer
          {...baseProps}
          toolCallId={toolCallId}
          toolOutput={sameOutput}
        />
        <WidgetSurfaceHost />
      </WidgetSurfaceHostProvider>
    );

    const { rerender } = render(renderTree("call-1"));

    await vi.waitFor(() => {
      expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
    });

    act(() => triggerReady());

    await vi.waitFor(() => {
      expect(mockBridge.sendToolResult).toHaveBeenCalledTimes(1);
    });

    rerender(renderTree("call-2"));

    await vi.waitFor(() => {
      expect(mockBridge.sendToolResult).toHaveBeenCalledTimes(2);
    });

    expect(mockBridge.sendToolResult).toHaveBeenLastCalledWith(sameOutput);
    expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
    expect(sandboxedIframeMountsRef.current).toBe(1);
    expect(sandboxedIframeUnmountsRef.current).toBe(0);
  });

  it("keeps the iframe alive when the same tool call anchor is re-keyed", async () => {
    const renderTree = (showCall: boolean) => (
      <WidgetSurfaceHostProvider>
        {showCall ? (
          <MCPAppsRenderer {...baseProps} toolCallId="call-1" />
        ) : null}
        <WidgetSurfaceHost />
      </WidgetSurfaceHostProvider>
    );

    const { rerender } = render(renderTree(true));

    await vi.waitFor(() => {
      expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("sandboxed-iframe")).toBeInTheDocument();
    });

    act(() => triggerReady());

    rerender(renderTree(false));
    rerender(renderTree(true));

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(screen.getByTestId("sandboxed-iframe")).toBeInTheDocument();
    expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
    expect(mockBridge.close).not.toHaveBeenCalled();
    expect(mockBridge.teardownResource).not.toHaveBeenCalled();
    expect(sandboxedIframeMountsRef.current).toBe(1);
    expect(sandboxedIframeUnmountsRef.current).toBe(0);
  });

  it("keeps fullscreen ownership for a persistent resource surface", async () => {
    render(
      <WidgetSurfaceHostProvider>
        <MCPAppsRenderer
          {...baseProps}
          toolCallId="call-1"
          displayMode="fullscreen"
          fullscreenWidgetId="call-1"
        />
        <WidgetSurfaceHost />
      </WidgetSurfaceHostProvider>
    );

    await vi.waitFor(() => {
      expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
    });

    expect(appBridgeArgsRef.current?.options?.hostContext?.displayMode).toBe(
      "fullscreen"
    );
    expect(mockBridge.close).not.toHaveBeenCalled();
    expect(mockBridge.teardownResource).not.toHaveBeenCalled();
    expect(sandboxedIframeMountsRef.current).toBe(1);
  });

  it("falls back to the spec-default 'no claims' blob when no style is resolvable", async () => {
    // No ChatboxHostStyleProvider, isPlaygroundActive is false in this test
    // setup, so effectiveHostStyle is null. The resolver MUST NOT silently
    // impersonate Claude here — it returns the spec-default {}.
    render(<MCPAppsRenderer {...baseProps} />);

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    const { sandbox: _sandbox, ...vendorOnly } =
      appBridgeArgsRef.current?.hostCapabilities ?? {};
    expect(vendorOnly).toEqual({});
  });

  it("flips advertised hostCapabilities when host style switches to chatgpt", async () => {
    render(
      <ChatboxHostStyleProvider value="chatgpt">
        <ChatboxHostThemeProvider value="dark">
          <MCPAppsRenderer {...baseProps} />
        </ChatboxHostThemeProvider>
      </ChatboxHostStyleProvider>
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(appBridgeArgsRef.current?.hostCapabilities).toEqual(
      expect.objectContaining(getHostCapabilitiesForStyle("chatgpt"))
    );
    // Sanity: profiles differ — switching is observable. Use a
    // distinguishing key (Claude advertises serverResources / logging;
    // ChatGPT doesn't) rather than full-blob inequality, which would
    // false-positive on shared keys.
    const advertised = appBridgeArgsRef.current?.hostCapabilities;
    expect(advertised).not.toHaveProperty("serverResources");
    expect(advertised).not.toHaveProperty("logging");
  });

  it("passes the same effectiveHostCapabilities to the modal as the inline AppBridge advertises", async () => {
    // Inline + modal must speak an identical HostCapabilities surface.
    // Previously the modal hardcoded {openLinks, serverTools,
    // serverResources, logging, updateModelContext, message} — that
    // disagreed with Copilot's matrix-derived blob (which drops
    // serverResources / logging) and silently ignored user overrides
    // in mcpProfile.apps.mcpAppsOverrides.
    mcpAppsModalPropsRef.current = null;
    render(
      <ChatboxHostStyleProvider value="copilot">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(mcpAppsModalPropsRef.current).not.toBeNull();
    });

    const modalCaps = mcpAppsModalPropsRef.current
      ?.effectiveHostCapabilities as Record<string, unknown>;
    const { sandbox: _sandbox, ...inlineVendorOnly } = (appBridgeArgsRef.current
      ?.hostCapabilities ?? {}) as Record<string, unknown>;
    expect(modalCaps).toEqual(inlineVendorOnly);
    // Sentinel: Copilot's preset matrix strips both keys in inline AND
    // modal post-fix. (Pre-fix the modal would have included them.)
    expect(modalCaps).not.toHaveProperty("serverResources");
    expect(modalCaps).not.toHaveProperty("logging");
  });

  it("includes HostContext.toolInfo when the matrix has toolInfo: true (Claude default)", async () => {
    render(
      <ChatboxHostStyleProvider value="claude">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>
    );
    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    const hostContext = appBridgeArgsRef.current?.options?.hostContext as
      | Record<string, unknown>
      | undefined;
    expect(hostContext).toHaveProperty("toolInfo");
    expect(
      (hostContext?.toolInfo as { tool: { name: string } }).tool.name
    ).toBe("test-tool");
  });

  it("omits HostContext.toolInfo entirely when the matrix has toolInfo: false (Copilot)", async () => {
    // Microsoft 365 Copilot doesn't deliver `app.getHostContext()?.toolInfo`
    // per its published Component-bridge table. A widget that probes
    // for that field must see undefined — same as real Copilot.
    render(
      <ChatboxHostStyleProvider value="copilot">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>
    );
    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    const hostContext = appBridgeArgsRef.current?.options?.hostContext as
      | Record<string, unknown>
      | undefined;
    expect(hostContext).not.toHaveProperty("toolInfo");
  });

  it("strips inherited HostContext.toolInfo when the matrix has toolInfo: false", async () => {
    mockHostContextStoreState.draftHostContext = {
      toolInfo: {
        id: "draft-call",
        tool: { name: "draft-tool" },
      },
    };

    render(
      <ChatboxHostStyleProvider value="copilot">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>
    );
    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    const hostContext = appBridgeArgsRef.current?.options?.hostContext as
      | Record<string, unknown>
      | undefined;
    expect(hostContext).not.toHaveProperty("toolInfo");
  });

  it("advertises matrix-clamped HostContext.availableDisplayModes (Copilot: ['fullscreen'] only)", async () => {
    // Copilot's published Component-bridge table says
    // requestDisplayMode is fullscreen-only. The matrix's
    // availableDisplayModes is ["fullscreen"]; the host must
    // advertise exactly that, not the inspector's permissive
    // default of all three.
    render(
      <ChatboxHostStyleProvider value="copilot">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>
    );
    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    const hostContext = appBridgeArgsRef.current?.options?.hostContext as
      | Record<string, unknown>
      | undefined;
    expect(hostContext?.availableDisplayModes).toEqual(["fullscreen"]);
  });

  it("advertises all three modes on Claude (full surface matrix)", async () => {
    render(
      <ChatboxHostStyleProvider value="claude">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>
    );
    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    const hostContext = appBridgeArgsRef.current?.options?.hostContext as
      | Record<string, unknown>
      | undefined;
    expect(hostContext?.availableDisplayModes).toEqual([
      "inline",
      "fullscreen",
      "pip",
    ]);
  });

  it("clamps HostContext.displayMode to the matrix allowlist (Copilot in pip parent state coerces to fullscreen)", async () => {
    // Regression: previously the matrix-clamped allowlist was only
    // written into `HostContext.availableDisplayModes`, but
    // `effectiveDisplayMode` was still computed against the
    // playground/configured allowlist alone. A Copilot host could
    // initialize or remain in `pip` if the parent's display state
    // was sticky `"pip"` from a previous widget, while advertising
    // `availableDisplayModes: ["fullscreen"]` — an inconsistent
    // HostContext. Fix clamps the displayMode against the matrix
    // too.
    render(
      <ChatboxHostStyleProvider value="copilot">
        <MCPAppsRenderer
          {...baseProps}
          displayMode="pip"
          pipWidgetId="call-1"
        />
      </ChatboxHostStyleProvider>
    );
    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    const hostContext = appBridgeArgsRef.current?.options?.hostContext as
      | Record<string, unknown>
      | undefined;
    // Matrix-clamped: only fullscreen is allowed, so pip coerces.
    expect(hostContext?.availableDisplayModes).toEqual(["fullscreen"]);
    expect(hostContext?.displayMode).toBe("fullscreen");
  });

  it("keeps HostContext.displayMode inside the advertised intersection for custom display-mode overrides", async () => {
    const profile: HostConfigMcpProfileV1 = {
      profileVersion: 1,
      apps: {
        mcpAppsOverrides: {
          availableDisplayModes: ["inline", "pip"],
        },
      },
    };
    mockHostContextStoreState.draftHostContext = {
      availableDisplayModes: ["fullscreen", "pip"],
    };

    render(
      <ActiveMcpProfileProvider value={profile}>
        <ChatboxHostStyleProvider value="claude">
          <MCPAppsRenderer
            {...baseProps}
            displayMode="fullscreen"
            fullscreenWidgetId="call-1"
          />
        </ChatboxHostStyleProvider>
      </ActiveMcpProfileProvider>
    );
    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    const hostContext = appBridgeArgsRef.current?.options?.hostContext as
      | Record<string, unknown>
      | undefined;
    expect(hostContext?.availableDisplayModes).toEqual(["pip"]);
    expect(hostContext?.displayMode).toBe("pip");
  });

  it("strips frameDomains and baseUriDomains from widgetCsp when matrix has those rows off (Copilot)", async () => {
    // PR D: Microsoft 365 Copilot doesn't honor
    // `_meta.ui.csp.frameDomains` or `_meta.ui.csp.baseUriDomains`
    // per its published Component-bridge table. A widget that
    // declares them should see them stripped on the simulated
    // Copilot host so the iframe sandbox reflects what real Copilot
    // applies. Uses the live-fetch path with a custom CSP payload —
    // the cached-replay branch forces permissive (no CSP), so we
    // bypass it here to exercise the gate.
    vi.mocked(authFetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          html: "<html><body>widget</body></html>",
          csp: {
            connectDomains: ["https://api.example.com"],
            resourceDomains: ["https://cdn.example.com"],
            frameDomains: ["https://embed.example.com"],
            baseUriDomains: ["https://base.example.com"],
          },
          permissions: {},
          permissive: false,
          mimeTypeValid: true,
          prefersBorder: true,
        }),
      status: 200,
      headers: new Headers(),
    } as Response);
    render(
      <ChatboxHostStyleProvider value="copilot">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>
    );
    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.csp).toBeDefined();
    });
    const csp = sandboxedIframePropsRef.current?.csp as
      | Record<string, unknown>
      | undefined;
    // Matrix-gated sub-fields stripped before the resolver sees
    // them; both routes (resolver output + pass-through fallback)
    // honor the gate.
    expect(csp?.frameDomains ?? []).toEqual([]);
    expect(csp?.baseUriDomains ?? []).toEqual([]);
    // Sibling allowlists (not matrix-gated today) survive.
    expect(csp?.connectDomains).toEqual(["https://api.example.com"]);
    expect(csp?.resourceDomains).toEqual(["https://cdn.example.com"]);
  });

  it("preserves frameDomains and baseUriDomains on Claude (full surface matrix)", async () => {
    // Counter-test: same CSP, but Claude's matrix honors both sub-
    // fields, so they round-trip into the iframe CSP. Guards
    // against the gate over-stripping.
    vi.mocked(authFetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          html: "<html><body>widget</body></html>",
          csp: {
            connectDomains: ["https://api.example.com"],
            resourceDomains: ["https://cdn.example.com"],
            frameDomains: ["https://embed.example.com"],
            baseUriDomains: ["https://base.example.com"],
          },
          permissions: {},
          permissive: false,
          mimeTypeValid: true,
          prefersBorder: true,
        }),
      status: 200,
      headers: new Headers(),
    } as Response);
    render(
      <ChatboxHostStyleProvider value="claude">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>
    );
    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.csp).toBeDefined();
    });
    const csp = sandboxedIframePropsRef.current?.csp as
      | Record<string, unknown>
      | undefined;
    expect(csp?.frameDomains).toEqual(["https://embed.example.com"]);
    expect(csp?.baseUriDomains).toEqual(["https://base.example.com"]);
  });

  it("ignores widget-declared permissions on Copilot (sandboxPermissions: false)", async () => {
    // PR D: simulated Copilot host doesn't pipe `_meta.ui.permissions`
    // to the iframe. Widget declaring `camera` should NOT see the
    // permission in the rendered iframe — the host treats the
    // declaration as if it weren't there.
    vi.mocked(authFetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          html: "<html><body>widget</body></html>",
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [],
            baseUriDomains: [],
          },
          permissions: { camera: {} },
          permissive: false,
          mimeTypeValid: true,
          prefersBorder: true,
        }),
      status: 200,
      headers: new Headers(),
    } as Response);
    render(
      <ChatboxHostStyleProvider value="copilot">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>
    );
    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>"
      );
    });
    // Permissions cleared on Copilot — matches what real Copilot does
    // (it doesn't honor the widget's permission declarations at all).
    expect(
      sandboxedIframePropsRef.current?.permissions ?? undefined
    ).toBeUndefined();
  });

  it("suppresses widget-declared permissions in the playground permissive escape hatch (Copilot)", async () => {
    // Regression: three review bots independently flagged the same
    // miss on #2242 — the `userTogglePermissive` branch (playground
    // + cspMode === "permissive" + non-chatbox surface + non-
    // minimal) still read raw `widgetPermissions`. On a Copilot
    // host with `sandboxPermissions: false`, the gate is supposed
    // to ignore widget-declared permissions; the permissive escape
    // hatch in the playground was leaking them through to the
    // iframe.
    //
    // Fix gates both sites in the userTogglePermissive return path
    // (resolver-input loop + pass-through fallback). This test
    // asserts widget-declared permissions stay suppressed even with
    // the playground in permissive mode.
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: true,
      mcpAppsCspMode: "permissive" as const,
    });
    // In playground mode the matrix resolves against the
    // preferences-store `sharedHostStyle`, not the chatbox provider
    // — set it to a host whose `mcpAppsCapabilities.sandboxPermissions`
    // is false. Copilot isn't in the `mockPreferencesState` enum
    // (claude | chatgpt), so we route through chatgpt — its matrix
    // also has sandboxPermissions: false per `OPENAI_APPS_FULL_SURFACE`
    // → wait, chatgpt's MCP matrix is `MCP_APPS_FULL_SURFACE` which
    // has sandboxPermissions: true. We need a host where the matrix
    // explicitly turns it off. The shortcut: write copilot-like
    // values directly via the matrix override.
    mockPreferencesState.hostStyle = "claude" as const;
    vi.mocked(authFetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          html: "<html><body>widget</body></html>",
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [],
            baseUriDomains: [],
          },
          permissions: { camera: {} },
          permissive: false,
          mimeTypeValid: true,
          prefersBorder: true,
        }),
      status: 200,
      headers: new Headers(),
    } as Response);
    // ActiveMcpProfileProvider sets the matrix override directly,
    // simulating a user who configured `sandboxPermissions: false`
    // via the matrix UI. This avoids the
    // playground-vs-chatbox-host-style routing wrinkle entirely:
    // the override path always wins regardless of which host style
    // is resolved.
    const copilotPermissionsOff: HostConfigMcpProfileV1 = {
      profileVersion: 1,
      apps: { mcpAppsOverrides: { sandboxPermissions: false } },
    };
    render(
      <ActiveMcpProfileProvider value={copilotPermissionsOff}>
        <MCPAppsRenderer {...baseProps} />
      </ActiveMcpProfileProvider>
    );
    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>"
      );
    });
    expect(
      sandboxedIframePropsRef.current?.permissions ?? undefined
    ).toBeUndefined();
  });

  it("honors widget-declared permissions on Claude", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          html: "<html><body>widget</body></html>",
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [],
            baseUriDomains: [],
          },
          permissions: { camera: {} },
          permissive: false,
          mimeTypeValid: true,
          prefersBorder: true,
        }),
      status: 200,
      headers: new Headers(),
    } as Response);
    render(
      <ChatboxHostStyleProvider value="claude">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>
    );
    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>"
      );
    });
    // Claude's matrix honors permissions → widget declaration
    // round-trips.
    const perms = sandboxedIframePropsRef.current?.permissions as
      | Record<string, unknown>
      | undefined;
    expect(perms).toBeDefined();
    expect(perms).toHaveProperty("camera");
  });

  it("does not block pure MCP Apps from booting while ChatGPT compat is enabled", async () => {
    render(
      <ChatboxHostStyleProvider value="chatgpt">
        <MCPAppsRenderer
          {...baseProps}
          toolState="input-streaming"
          toolInput={{ query: "yellow" }}
          toolOutput={undefined}
        />
      </ChatboxHostStyleProvider>
    );

    await vi.waitFor(() => {
      expect(authFetch).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
  });

  it("waits for completed tool output before booting legacy OpenAI outputTemplate widgets", async () => {
    const { rerender } = render(
      <ChatboxHostStyleProvider value="chatgpt">
        <MCPAppsRenderer
          {...baseProps}
          toolState="input-streaming"
          toolInput={{ query: "yellow" }}
          toolOutput={undefined}
          toolMetadata={{ "openai/outputTemplate": "ui://widget/test.html" }}
        />
      </ChatboxHostStyleProvider>
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(authFetch).not.toHaveBeenCalled();
    expect(mockBridge.connect).not.toHaveBeenCalled();

    rerender(
      <ChatboxHostStyleProvider value="chatgpt">
        <MCPAppsRenderer
          {...baseProps}
          toolState="output-available"
          toolInput={{ query: "yellow" }}
          toolOutput={{
            content: [{ type: "text", text: "done" }],
            structuredContent: { route: "Yellow-N" },
          }}
          toolMetadata={{ "openai/outputTemplate": "ui://widget/test.html" }}
        />
      </ChatboxHostStyleProvider>
    );

    await vi.waitFor(() => {
      expect(authFetch).toHaveBeenCalled();
    });

    const requestInit = vi.mocked(authFetch).mock.calls[0]?.[1] as
      | RequestInit
      | undefined;
    const body = JSON.parse(String(requestInit?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(body.toolOutput).toEqual({
      content: [{ type: "text", text: "done" }],
      structuredContent: { route: "Yellow-N" },
    });
  });

  it("still waits for completed compat output when live fetch is preferred over a cached URL", async () => {
    const { rerender } = render(
      <ChatboxHostStyleProvider value="chatgpt">
        <MCPAppsRenderer
          {...baseProps}
          toolState="input-streaming"
          toolInput={{ query: "yellow" }}
          toolOutput={undefined}
          toolMetadata={{ "openai/outputTemplate": "ui://widget/test.html" }}
          cachedWidgetHtmlUrl="blob:cached"
          liveFetchPreferred
        />
      </ChatboxHostStyleProvider>
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(authFetch).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalledWith("blob:cached");
    expect(mockBridge.connect).not.toHaveBeenCalled();

    rerender(
      <ChatboxHostStyleProvider value="chatgpt">
        <MCPAppsRenderer
          {...baseProps}
          toolState="output-available"
          toolInput={{ query: "yellow" }}
          toolOutput={{
            content: [{ type: "text", text: "done" }],
            structuredContent: { route: "Yellow-N" },
          }}
          toolMetadata={{ "openai/outputTemplate": "ui://widget/test.html" }}
          cachedWidgetHtmlUrl="blob:cached"
          liveFetchPreferred
        />
      </ChatboxHostStyleProvider>
    );

    await vi.waitFor(() => {
      expect(authFetch).toHaveBeenCalled();
    });

    expect(global.fetch).not.toHaveBeenCalledWith("blob:cached");

    const requestInit = vi.mocked(authFetch).mock.calls[0]?.[1] as
      | RequestInit
      | undefined;
    const body = JSON.parse(String(requestInit?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(body.toolOutput).toEqual({
      content: [{ type: "text", text: "done" }],
      structuredContent: { route: "Yellow-N" },
    });
  });

  it("user override wins over the host style preset", async () => {
    const override = {
      openLinks: {},
      // Intentionally omits serverTools / serverResources / message etc.
      // so the resolved blob is observably distinct from both presets.
    };
    render(
      <ChatboxHostCapabilitiesOverrideProvider value={override}>
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostCapabilitiesOverrideProvider>
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    const { sandbox: _sandbox, ...vendorOnly } =
      appBridgeArgsRef.current?.hostCapabilities ?? {};
    expect(vendorOnly).toEqual(override);
  });

  it("uses chatbox host style for SEP-1865 host context outside the playground", async () => {
    render(
      <ChatboxHostStyleProvider value="chatgpt">
        <ChatboxHostThemeProvider value="dark">
          <MCPAppsRenderer {...baseProps} />
        </ChatboxHostThemeProvider>
      </ChatboxHostStyleProvider>
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(
      appBridgeArgsRef.current?.options?.hostContext?.styles?.variables?.[
        "--color-background-primary"
      ]
    ).toBe(
      CHATGPT_HOST_STYLE.mcp.resolveStyleVariables("dark")[
        "--color-background-primary"
      ]
    );

    await act(async () => {
      triggerReady();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mockBridge.setHostContext).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: "web",
          styles: expect.objectContaining({
            variables: expect.objectContaining({
              "--color-background-primary":
                CHATGPT_HOST_STYLE.mcp.resolveStyleVariables("dark")[
                  "--color-background-primary"
                ],
            }),
            css: expect.objectContaining({
              fonts: "",
            }),
          }),
        })
      );
    });
  });

  it("uses the current chat host theme for host context outside the playground", async () => {
    mockPreferencesState.themeMode = "light";
    mockHostContextStoreState.draftHostContext = {
      theme: "light",
    };

    render(
      <ChatboxHostStyleProvider value="claude">
        <ChatboxHostThemeProvider value="dark">
          <MCPAppsRenderer {...baseProps} />
        </ChatboxHostThemeProvider>
      </ChatboxHostStyleProvider>
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(appBridgeArgsRef.current?.options?.hostContext?.theme).toBe("dark");
    expect(
      appBridgeArgsRef.current?.options?.hostContext?.styles?.variables?.[
        "--color-background-primary"
      ]
    ).toBe(
      CLAUDE_HOST_STYLE.mcp.resolveStyleVariables("dark")[
        "--color-background-primary"
      ]
    );

    await act(async () => {
      triggerReady();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mockBridge.setHostContext).toHaveBeenLastCalledWith(
        expect.objectContaining({
          theme: "dark",
          styles: expect.objectContaining({
            variables: expect.objectContaining({
              "--color-background-primary":
                CLAUDE_HOST_STYLE.mcp.resolveStyleVariables("dark")[
                  "--color-background-primary"
                ],
            }),
          }),
        })
      );
    });
  });

  it("keeps explicit host context theme inside the playground", async () => {
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: true,
    });
    mockPreferencesState.themeMode = "dark";
    mockHostContextStoreState.draftHostContext = {
      theme: "light",
    };

    render(<MCPAppsRenderer {...baseProps} />);

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(appBridgeArgsRef.current?.options?.hostContext?.theme).toBe("light");

    await act(async () => {
      triggerReady();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mockBridge.setHostContext).toHaveBeenLastCalledWith(
        expect.objectContaining({
          theme: "light",
        })
      );
    });
  });

  it("clamps configured host display modes before sending host context", async () => {
    mockHostContextStoreState.draftHostContext = {
      displayMode: "fullscreen",
      availableDisplayModes: ["inline"],
      locale: "fr-FR",
      timeZone: "Europe/Paris",
    };

    render(<MCPAppsRenderer {...baseProps} />);

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    await act(async () => {
      triggerReady();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mockBridge.setHostContext).toHaveBeenCalledWith(
        expect.objectContaining({
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          locale: "fr-FR",
          timeZone: "Europe/Paris",
        })
      );
    });
  });

  it("layers sanitized custom host style variables over host defaults", async () => {
    mockHostContextStoreState.draftHostContext = {
      styles: {
        variables: {
          "--font-sans": "Custom Sans",
          "--mcpjam-theme-preset": "soft-pop",
          "--totally-unknown": "ignore-me",
        },
      },
    };

    render(
      <ChatboxHostStyleProvider value="claude">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(
      appBridgeArgsRef.current?.options?.hostContext?.styles?.variables
    ).toEqual(
      expect.objectContaining({
        "--color-background-primary":
          CLAUDE_HOST_STYLE.mcp.resolveStyleVariables("light")[
            "--color-background-primary"
          ],
        "--font-sans": "Custom Sans",
      })
    );
    expect(
      appBridgeArgsRef.current?.options?.hostContext?.styles?.variables
    ).not.toHaveProperty("--mcpjam-theme-preset");
    expect(
      appBridgeArgsRef.current?.options?.hostContext?.styles?.variables
    ).not.toHaveProperty("--totally-unknown");

    await act(async () => {
      triggerReady();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mockBridge.setHostContext).toHaveBeenLastCalledWith(
        expect.objectContaining({
          styles: expect.objectContaining({
            variables: expect.objectContaining({
              "--color-background-primary":
                CLAUDE_HOST_STYLE.mcp.resolveStyleVariables("light")[
                  "--color-background-primary"
                ],
              "--font-sans": "Custom Sans",
            }),
          }),
        })
      );
    });
  });

  it("aligns the sandbox iframe with the host surface while providing host chrome", async () => {
    render(
      <ChatboxHostStyleProvider value="claude">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>
    );

    const iframe = await screen.findByTestId("sandboxed-iframe");
    const hostChrome = screen.getByTestId("mcp-app-host-chrome");

    expect(iframe.className).toContain("bg-transparent");
    expect(sandboxedIframePropsRef.current?.style?.backgroundColor).toBe(
      CLAUDE_HOST_STYLE.mcp.resolveStyleVariables("light")[
        "--color-background-primary"
      ]
    );
    expect(sandboxedIframePropsRef.current?.colorScheme).toBe("light");
    expect(hostChrome).toHaveStyle({
      backgroundColor:
        CLAUDE_HOST_STYLE.mcp.resolveStyleVariables("light")[
          "--color-background-primary"
        ],
    });
  });

  it("does not add host chrome when the widget opts out of border/background", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          html: "<html><body>live-widget</body></html>",
          csp: undefined,
          permissions: undefined,
          permissive: false,
          mimeTypeValid: true,
          prefersBorder: false,
        }),
      status: 200,
      headers: new Headers(),
    } as Response);

    render(
      <ChatboxHostStyleProvider value="claude">
        <MCPAppsRenderer {...baseProps} prefersBorder={false} />
      </ChatboxHostStyleProvider>
    );

    const iframe = await screen.findByTestId("sandboxed-iframe");

    expect(screen.queryByTestId("mcp-app-host-chrome")).not.toBeInTheDocument();
    expect(iframe.className).toContain("bg-transparent");
    expect(iframe.className).not.toContain("border border-border/40");
    expect(sandboxedIframePropsRef.current?.style?.backgroundColor).toBe(
      CLAUDE_HOST_STYLE.chatUi.resolveChatBackground("light")
    );
    expect(sandboxedIframePropsRef.current?.colorScheme).toBe("light");
  });

  it("anchors desktop playground PiP to the playground shell instead of the viewport", async () => {
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: true,
      displayMode: "pip",
      deviceType: "desktop",
    });

    render(
      <MCPAppsRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="pip"
        pipWidgetId="call-1"
      />
    );

    const iframe = await screen.findByTestId("sandboxed-iframe");
    const hostChrome = iframe.parentElement as HTMLElement | null;
    const container = hostChrome?.parentElement as HTMLElement | null;
    expect(hostChrome?.dataset.testid).toBe("mcp-app-host-chrome");
    expect(container).not.toBeNull();
    expect(container?.className).toContain("absolute");
    expect(container?.className).not.toContain("fixed");
    expect(container?.className).toContain("top-4");
  });

  it("keeps desktop playground fullscreen as a fixed breakout overlay", async () => {
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: true,
      displayMode: "fullscreen",
      deviceType: "desktop",
    });

    render(
      <MCPAppsRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="fullscreen"
        fullscreenWidgetId="call-1"
      />
    );

    const iframe = await screen.findByTestId("sandboxed-iframe");
    const stableChromeWrapper = iframe.parentElement as HTMLElement | null;
    const container = stableChromeWrapper?.parentElement as HTMLElement | null;
    expect(stableChromeWrapper?.className).toContain("contents");
    expect(container).not.toBeNull();
    expect(container?.className).toContain("fixed");
    expect(container?.className).toContain("inset-0");
  });

  it("keeps the sandbox iframe mounted when toggling fullscreen", async () => {
    const renderInline = () => (
      <MCPAppsRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="inline"
      />
    );
    const { rerender } = render(renderInline());

    await screen.findByTestId("sandboxed-iframe");
    await vi.waitFor(() => {
      expect(sandboxedIframeMountsRef.current).toBe(1);
    });
    const initialIframeElement = sandboxedIframeElementRef.current;
    expect(initialIframeElement).not.toBeNull();

    rerender(
      <MCPAppsRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="fullscreen"
        fullscreenWidgetId="call-1"
      />
    );

    expect(sandboxedIframeElementRef.current).toBe(initialIframeElement);
    expect(sandboxedIframeUnmountsRef.current).toBe(0);

    rerender(renderInline());

    expect(sandboxedIframeElementRef.current).toBe(initialIframeElement);
    expect(sandboxedIframeUnmountsRef.current).toBe(0);
    expect(screen.getByTestId("mcp-app-host-chrome")).toBeInTheDocument();
  });

  it("preserves inline height when fullscreen widgets report viewport size", async () => {
    const renderInline = () => (
      <MCPAppsRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="inline"
      />
    );
    const { rerender } = render(renderInline());

    await screen.findByTestId("sandboxed-iframe");
    await vi.waitFor(() => {
      expect(mockBridge.onsizechange).toBeTypeOf("function");
    });

    act(() => {
      mockBridge.onsizechange?.({ width: 400, height: 300 });
    });
    rerender(renderInline());
    expect(sandboxedIframePropsRef.current?.style?.height).toBe("300px");

    rerender(
      <MCPAppsRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="fullscreen"
        fullscreenWidgetId="call-1"
      />
    );
    expect(sandboxedIframePropsRef.current?.style?.height).toBe("100%");

    act(() => {
      mockBridge.onsizechange?.({ width: 1200, height: 900 });
    });
    rerender(renderInline());

    expect(sandboxedIframePropsRef.current?.style?.height).toBe("300px");
  });

  it("applies size-changed width to the inline renderer container", async () => {
    const renderInline = () => (
      <MCPAppsRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="inline"
      />
    );
    const { rerender } = render(renderInline());

    await screen.findByTestId("sandboxed-iframe");
    await vi.waitFor(() => {
      expect(mockBridge.onsizechange).toBeTypeOf("function");
    });

    act(() => {
      mockBridge.onsizechange?.({ width: 300, height: 300 });
    });

    const hostChrome = screen.getByTestId("mcp-app-host-chrome");
    const container = hostChrome.parentElement as HTMLElement;
    expect(container.style.width).toBe("300px");

    rerender(renderInline());
    expect(hostChrome.parentElement).toHaveStyle({
      width: "300px",
      maxWidth: "100%",
    });
    expect(sandboxedIframePropsRef.current?.style?.width).toBe("100%");
  });

  it("pushes updated host context when the project client profile changes", async () => {
    const { rerender } = render(<MCPAppsRenderer {...baseProps} />);

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    await act(async () => {
      triggerReady();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mockBridge.setHostContext).toHaveBeenCalledWith(
        expect.objectContaining({
          locale: "en-US",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
      );
    });

    mockHostContextStoreState.draftHostContext = {
      locale: "es-ES",
      timeZone: "Europe/Madrid",
      deviceCapabilities: {
        hover: false,
        touch: true,
      },
    };

    rerender(<MCPAppsRenderer {...baseProps} />);

    await vi.waitFor(() => {
      expect(mockBridge.setHostContext).toHaveBeenLastCalledWith(
        expect.objectContaining({
          locale: "es-ES",
          timeZone: "Europe/Madrid",
          deviceCapabilities: {
            hover: false,
            touch: true,
          },
        })
      );
    });
  });

  it("forces permissive replay for cached HTML even when strict replay metadata is stored", async () => {
    render(
      <MCPAppsRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        widgetCsp={{
          connectDomains: ["https://ignored.example.com"],
          resourceDomains: ["https://ignored.example.com"],
          frameDomains: [],
          baseUriDomains: [],
        }}
        widgetPermissions={{ clipboardWrite: true } as any}
        widgetPermissive={false}
      />
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>"
      );
    });

    expect(sandboxedIframePropsRef.current?.permissive).toBe(true);
    expect(sandboxedIframePropsRef.current?.csp).toBeUndefined();
    expect(sandboxedIframePropsRef.current?.permissions).toBeUndefined();
  });

  it("forces permissive replay for cached HTML even when permissive replay metadata is stored", async () => {
    render(
      <MCPAppsRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        widgetCsp={{
          connectDomains: ["https://ignored.example.com"],
          resourceDomains: ["https://ignored.example.com"],
          frameDomains: [],
          baseUriDomains: [],
        }}
        widgetPermissions={{ geolocation: true } as any}
        widgetPermissive={true}
      />
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>"
      );
    });

    expect(sandboxedIframePropsRef.current?.permissive).toBe(true);
    expect(sandboxedIframePropsRef.current?.csp).toBeUndefined();
    expect(sandboxedIframePropsRef.current?.permissions).toBeUndefined();
  });

  it("keeps the live fetch path on server-declared strict widget settings", async () => {
    render(<MCPAppsRenderer {...baseProps} />);

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>live-widget</body></html>"
      );
    });

    expect(sandboxedIframePropsRef.current?.permissive).toBe(false);
    expect(sandboxedIframePropsRef.current?.csp).toEqual({
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
      frameDomains: [],
      baseUriDomains: [],
    });
    expect(sandboxedIframePropsRef.current?.permissions).toEqual({
      camera: true,
    });
  });

  it("prefers the live fetch over cached HTML when liveFetchPreferred is set", async () => {
    render(
      <MCPAppsRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        liveFetchPreferred
      />
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>live-widget</body></html>"
      );
    });

    // authFetch is the live-fetch lever; the cached fetch goes through global.fetch.
    // Successful live → cached blob URL must not be fetched.
    expect(vi.mocked(authFetch)).toHaveBeenCalled();
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalledWith("blob:cached");
    expect(sandboxedIframePropsRef.current?.permissive).toBe(false);
  });

  it("uses the current live compat recipe for live-preferred cached revisits", async () => {
    render(
      <ChatboxHostStyleProvider value="chatgpt">
        <MCPAppsRenderer
          {...baseProps}
          cachedWidgetHtmlUrl="blob:cached"
          liveFetchPreferred
          injectedOpenAiCompat={false}
          injectedOpenAiCompatCapabilities={{ callTool: false }}
        />
      </ChatboxHostStyleProvider>
    );

    await vi.waitFor(() => {
      expect(authFetch).toHaveBeenCalled();
    });

    const requestInit = vi.mocked(authFetch).mock.calls[0]?.[1] as
      | RequestInit
      | undefined;
    const body = JSON.parse(String(requestInit?.body ?? "{}")) as Record<
      string,
      any
    >;
    expect(body.injectOpenAiCompat).toBe(true);
    expect(body.openAiCompatCapabilities?.callTool).toBe(true);
  });

  it("falls back to cached HTML when the live fetch throws (e.g. server disconnected)", async () => {
    vi.mocked(authFetch).mockRejectedValueOnce(
      new Error('Hosted server not found for "server-1"')
    );

    render(
      <MCPAppsRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        liveFetchPreferred
      />
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>"
      );
    });

    // Live attempted, threw, then cached blob fetched.
    expect(vi.mocked(authFetch)).toHaveBeenCalled();
    expect(vi.mocked(global.fetch)).toHaveBeenCalledWith("blob:cached");
    // Cached path forces permissive rendering.
    expect(sandboxedIframePropsRef.current?.permissive).toBe(true);
  });

  it("first-render cspMode derives from WidgetSurfaceProvider, not isPlaygroundActive", async () => {
    // Regression for the "draw a cat, then it vanishes" iframe re-mount
    // bug. Previously `cspMode` came from `isPlaygroundActive`, which was
    // set in a passive useEffect by PlaygroundMain. First render saw
    // `false` → cspMode = "widget-declared" → live fetch with that
    // mode; the effect then committed → flag flipped → cspMode flipped
    // → fetch-source key changed → iframe remounted and lost View state.
    //
    // The fix routes cspMode through WidgetSurfaceContext, which
    // propagates synchronously on the first render. This test pins
    // that contract so a future refactor reintroducing a global-flag
    // dependency on cspMode would flip the assertion.
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: false,
      mcpAppsCspMode: "permissive",
    });

    render(
      <WidgetSurfaceProvider value="playground">
        <MCPAppsRenderer {...baseProps} />
      </WidgetSurfaceProvider>
    );

    await vi.waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalled();
    });

    // First live fetch must already carry the playground cspMode —
    // proves no race, no second fetch with the corrected mode.
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(authFetch).mock.calls[0];
    const body = JSON.parse(firstCall[1]!.body as string);
    expect(body.cspMode).toBe("permissive");
  });

  it("first-render cspMode falls back to 'widget-declared' outside the playground surface", async () => {
    // Symmetric guard: without the WidgetSurfaceProvider, the renderer
    // is on the chat surface and must use the strict default —
    // regardless of any leaked store flag value.
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: true,
      mcpAppsCspMode: "permissive",
    });

    render(<MCPAppsRenderer {...baseProps} />);

    await vi.waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalled();
    });

    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(authFetch).mock.calls[0];
    const body = JSON.parse(firstCall[1]!.body as string);
    expect(body.cspMode).toBe("widget-declared");
  });

  it("drops stale live-fetch results when the source key has moved on (renderer reuse)", async () => {
    // Hold the first live fetch open with a controllable promise so we can
    // simulate the source key changing (e.g. session swap, cspMode toggle,
    // or different resource URI) before it resolves.
    let resolveStale!: (response: Response) => void;
    const staleResponse = new Promise<Response>((r) => {
      resolveStale = r;
    });
    vi.mocked(authFetch).mockImplementationOnce(() => staleResponse);

    const { rerender } = render(
      <MCPAppsRenderer
        {...baseProps}
        resourceUri="mcp-app://stale"
        cachedWidgetHtmlUrl="blob:cached"
        liveFetchPreferred
      />
    );

    // Wait for the stale fetch to start.
    await vi.waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
    });

    // Re-render with a new resource URI. This rotates the source-identity key.
    // A second live fetch is queued for the new key; we let it resolve
    // normally with the default authFetch mock.
    rerender(
      <MCPAppsRenderer
        {...baseProps}
        resourceUri="mcp-app://fresh"
        cachedWidgetHtmlUrl="blob:cached"
        liveFetchPreferred
      />
    );

    // Wait for the fresh fetch to complete and paint the sandbox.
    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>live-widget</body></html>"
      );
    });

    // Now resolve the *stale* fetch with a different payload. The renderer
    // must drop it — the iframe must keep showing the fresh HTML.
    await act(async () => {
      resolveStale({
        ok: true,
        json: () =>
          Promise.resolve({
            html: "<html><body>STALE-CONTENT</body></html>",
            csp: null,
            permissions: null,
            permissive: true,
            mimeTypeValid: true,
            prefersBorder: true,
          }),
        status: 200,
        headers: new Headers(),
      } as Response);
      // Flush microtasks so any guarded setState would have committed.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sandboxedIframePropsRef.current?.html).toBe(
      "<html><body>live-widget</body></html>"
    );
    expect(sandboxedIframePropsRef.current?.html).not.toContain(
      "STALE-CONTENT"
    );
  });

  it("does not fall back to cached HTML when the live fetch returns an invalid mimetype", async () => {
    // Server reachable but template misconfigured — invalid mimetype is a
    // content error, not a transport error. The renderer must surface it
    // and not silently mask it with stale cached HTML.
    vi.mocked(authFetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          html: "<html><body>live-widget</body></html>",
          csp: null,
          permissions: null,
          permissive: false,
          mimeTypeValid: false,
          mimeTypeWarning:
            'Resource served as "text/html" but SEP-1865 requires "text/html;profile=mcp-app"',
          prefersBorder: true,
        }),
      status: 200,
      headers: new Headers(),
    } as Response);

    render(
      <MCPAppsRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        liveFetchPreferred
      />
    );

    await vi.waitFor(() => {
      expect(screen.getByText(/SEP-1865 requires/i)).toBeInTheDocument();
    });

    // Cached blob must NOT be fetched on invalid mimetype.
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalledWith("blob:cached");
    // No widget HTML should have made it to the sandbox — the renderer is
    // showing the error UI in place of the iframe, so `html` is either null
    // (iframe still mounted but unset) or the iframe is not mounted at all.
    expect(sandboxedIframePropsRef.current?.html ?? null).toBeNull();
  });

  it("waits for the bridge transport before loading widget HTML into the sandbox", async () => {
    let resolveConnect: (() => void) | undefined;
    mockBridge.connect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        })
    );

    render(
      <MCPAppsRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(sandboxedIframePropsRef.current?.html).toBeNull();

    await act(async () => {
      resolveConnect?.();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>"
      );
    });
  });

  it("waits for the sandbox proxy before starting the bridge handshake", async () => {
    sandboxProxyBehaviorRef.current.autoReady = false;

    render(
      <MCPAppsRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />
    );

    await vi.waitFor(() => {
      // Third arg is the persisted compat-runtime provenance for the
      // cached HTML; fourth is the persisted per-method capability
      // surface that accompanies it. The test props don't carry either,
      // so there's no provenance to record — the renderer passes
      // `undefined` for both rather than inferring from the live host
      // config (HTML is byte-frozen at capture time; live state could lie).
      expect(stableStoreFns.setWidgetHtml).toHaveBeenCalledWith(
        "call-1",
        "<html><body>widget</body></html>",
        undefined,
        undefined
      );
    });

    expect(mockBridge.connect).not.toHaveBeenCalled();
    expect(sandboxedIframePropsRef.current?.html).toBeNull();

    await act(async () => {
      sandboxedIframePropsRef.current?.onProxyReady?.();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>"
      );
    });
  });

  it("publishes the resolved sandbox payload + lifecycle into widget-debug-store", async () => {
    // Verifies the Phase 4 plumbing: as soon as the effectiveSandbox useMemo
    // settles, setSandboxApplied fires; as widget-content-* / bridge-* events
    // flow through logWidgetDebug, appendLifecycle fans them out into the
    // store's lifecycle array. This is the runtime feed the Sandbox debug
    // panel reads — if it stops happening the panel silently goes blank.
    render(
      <MCPAppsRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />
    );

    await vi.waitFor(() => {
      // setSandboxApplied is called with the resolved payload shape we
      // documented in WidgetSandboxApplied. We don't pin the exact CSP
      // values (those are the resolver's concern) — just the contract.
      expect(stableStoreFns.setSandboxApplied).toHaveBeenCalledWith(
        "call-1",
        expect.objectContaining({
          permissive: expect.any(Boolean),
          hostPolicyApplied: expect.any(Boolean),
        }),
        undefined,
        // hostInfo derived from activeMcpProfile.apps.uiInitialize.hostInfo;
        // null in the test environment because the default context value is
        // `undefined` (no ActiveMcpProfileProvider wrapping the renderer).
        null
      );
    });

    await vi.waitFor(() => {
      // At least one lifecycle event from the renderer's existing
      // logWidgetDebug emissions made it through the bridge.
      expect(stableStoreFns.appendLifecycle).toHaveBeenCalled();
    });
  });

  it("sends partial tool input during input-streaming", async () => {
    const partialInput = { elements: '[{"type":"rectangle"' };
    render(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-streaming"
        toolInput={partialInput}
        cachedWidgetHtmlUrl="blob:cached"
      />
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
      />
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    act(() => triggerReady());
    act(() => {
      mockBridge.onsizechange?.({ width: 400, height: 300 });
    });

    const iframe = screen.getByTestId("sandboxed-iframe") as HTMLElement;
    expect(iframe.style.opacity).toBe("0");
    expect(iframe.style.position).toBe("absolute");
    expect(iframe.style.pointerEvents).toBe("none");

    const partialInput = { elements: '[{"type":"rectangle"' };
    rerender(
      <MCPAppsRenderer
        {...baseProps}
        toolState="input-streaming"
        toolInput={partialInput}
        cachedWidgetHtmlUrl="blob:cached"
      />
    );

    await vi.waitFor(() => {
      expect(mockBridge.sendToolInputPartial).toHaveBeenCalledWith({
        arguments: partialInput,
      });
    });
    await vi.waitFor(() => {
      expect(iframe.style.opacity).toBe("1");
      expect(iframe.style.position).toBe("");
      expect(iframe.style.pointerEvents).toBe("");
    });
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
      />
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
      />
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
      />
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
      />
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
      />
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
      />
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
      />
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
      />
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
      />
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
      />
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
      />
    );
    await vi.waitFor(() => {
      expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(2);
    });
  });

  it("sends tool output when widget becomes ready", async () => {
    render(
      <MCPAppsRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    act(() => triggerReady());

    await vi.waitFor(() => {
      expect(mockBridge.sendToolResult).toHaveBeenCalledTimes(1);
      expect(mockBridge.sendToolResult).toHaveBeenCalledWith(
        baseProps.toolOutput
      );
    });
  });

  it("re-sends tool output when prop changes", async () => {
    const { rerender } = render(
      <MCPAppsRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />
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
      />
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
      />
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
      />
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
      <MCPAppsRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />
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
      />
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
      />
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

// ── Host capability gating ─────────────────────────────────────────────────
// Every chip-bound bridge handler is only assigned when the matching
// `effectiveHostCapabilities.*` field is set. An unassigned handler slot
// causes the SDK to auto-respond with "method not supported" — keeping
// advertise and enforce in lockstep.
describe("MCPAppsRenderer host capability enforcement", () => {
  beforeEach(() => {
    // Reset every handler slot so each test observes a clean slate. The
    // outer beforeEach only resets oninitialized; capability gating tests
    // care about all of them.
    mockBridge.oninitialized = null;
    mockBridge.onmessage = null;
    mockBridge.onopenlink = null;
    mockBridge.oncalltool = null;
    mockBridge.onreadresource = null;
    mockBridge.onlistresources = null;
    mockBridge.onlistresourcetemplates = null;
    mockBridge.onlistprompts = null;
    mockBridge.onloggingmessage = null;
    mockBridge.onsizechange = null;
    mockBridge.onrequestdisplaymode = null;
    mockBridge.onupdatemodelcontext = null;
  });

  it("does not register chip-bound handlers when no capability is advertised", async () => {
    render(
      <ChatboxHostCapabilitiesOverrideProvider value={{}}>
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostCapabilitiesOverrideProvider>
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(mockBridge.onmessage).toBeNull();
    expect(mockBridge.onopenlink).toBeNull();
    expect(mockBridge.oncalltool).toBeNull();
    expect(mockBridge.onreadresource).toBeNull();
    expect(mockBridge.onlistresources).toBeNull();
    expect(mockBridge.onlistresourcetemplates).toBeNull();
    expect(mockBridge.onloggingmessage).toBeNull();
    expect(mockBridge.onupdatemodelcontext).toBeNull();
  });

  it("keeps non-gated handlers wired regardless of cap surface", async () => {
    render(
      <ChatboxHostCapabilitiesOverrideProvider value={{}}>
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostCapabilitiesOverrideProvider>
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    // Infrastructure handlers (handshake, iframe resize, display mode) and
    // prompts (no cap surface today) must stay assigned even with an empty
    // capability blob.
    expect(mockBridge.oninitialized).not.toBeNull();
    expect(mockBridge.onsizechange).not.toBeNull();
    expect(mockBridge.onrequestdisplaymode).not.toBeNull();
    expect(mockBridge.onlistprompts).not.toBeNull();
  });

  const capHandlerPairs: ReadonlyArray<
    readonly [keyof McpUiHostCapabilities, keyof typeof mockBridge]
  > = [
    ["openLinks", "onopenlink"],
    ["serverTools", "oncalltool"],
    ["logging", "onloggingmessage"],
    ["updateModelContext", "onupdatemodelcontext"],
    ["message", "onmessage"],
  ];

  it.each(capHandlerPairs)(
    "registers the %s handler when the cap is advertised",
    async (cap, handlerKey) => {
      render(
        <ChatboxHostCapabilitiesOverrideProvider value={{ [cap]: {} }}>
          <MCPAppsRenderer {...baseProps} />
        </ChatboxHostCapabilitiesOverrideProvider>
      );

      await vi.waitFor(() => {
        expect(mockBridge.connect).toHaveBeenCalled();
      });

      expect(mockBridge[handlerKey]).not.toBeNull();
    }
  );

  it("registers all three serverResources handlers under a single cap", async () => {
    render(
      <ChatboxHostCapabilitiesOverrideProvider value={{ serverResources: {} }}>
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostCapabilitiesOverrideProvider>
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(mockBridge.onreadresource).not.toBeNull();
    expect(mockBridge.onlistresources).not.toBeNull();
    expect(mockBridge.onlistresourcetemplates).not.toBeNull();
  });

  it("leaves serverResources handlers unregistered without the cap", async () => {
    render(
      <ChatboxHostCapabilitiesOverrideProvider value={{ openLinks: {} }}>
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostCapabilitiesOverrideProvider>
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    // Adjacent cap advertised, but serverResources is not — the three
    // resource handlers must stay unassigned so the SDK rejects callers.
    expect(mockBridge.onopenlink).not.toBeNull();
    expect(mockBridge.onreadresource).toBeNull();
    expect(mockBridge.onlistresources).toBeNull();
    expect(mockBridge.onlistresourcetemplates).toBeNull();
  });
});

// SEP-1865 host policy for widget-initiated `ui/request-display-mode`.
// Spec permits the host to decline these requests; the matrix exposes
// the policy as a tri-state knob. These tests assert the bridge handler
// gates correctly for each value.
describe("MCPAppsRenderer widgetDisplayModeRequests policy", () => {
  beforeEach(() => {
    mockBridge.onrequestdisplaymode = null;
  });

  const profileWith = (
    policy: "accept" | "user-initiated-only" | "decline"
  ): HostConfigMcpProfileV1 => ({
    profileVersion: 1,
    apps: { mcpAppsOverrides: { widgetDisplayModeRequests: policy } },
  });

  it("accept: grants the widget's fullscreen request", async () => {
    render(
      <ActiveMcpProfileProvider value={profileWith("accept")}>
        <ChatboxHostStyleProvider value="claude">
          <MCPAppsRenderer {...baseProps} />
        </ChatboxHostStyleProvider>
      </ActiveMcpProfileProvider>
    );
    await vi.waitFor(() => {
      expect(mockBridge.onrequestdisplaymode).not.toBeNull();
    });
    const handler = mockBridge.onrequestdisplaymode as unknown as (args: {
      mode: "inline" | "fullscreen" | "pip";
    }) => Promise<{ mode: string }>;
    const result = await handler({ mode: "fullscreen" });
    expect(result.mode).toBe("fullscreen");
  });

  it("decline: returns the current mode instead of the requested fullscreen", async () => {
    render(
      <ActiveMcpProfileProvider value={profileWith("decline")}>
        <ChatboxHostStyleProvider value="claude">
          <MCPAppsRenderer {...baseProps} />
        </ChatboxHostStyleProvider>
      </ActiveMcpProfileProvider>
    );
    await vi.waitFor(() => {
      expect(mockBridge.onrequestdisplaymode).not.toBeNull();
    });
    const handler = mockBridge.onrequestdisplaymode as unknown as (args: {
      mode: "inline" | "fullscreen" | "pip";
    }) => Promise<{ mode: string }>;
    const result = await handler({ mode: "fullscreen" });
    expect(result.mode).toBe("inline");
  });

  it("user-initiated-only: declines a widget fullscreen request on first mount", async () => {
    // Sticky-inline ref is seeded `true` at mount under this policy, so
    // a widget that requests fullscreen on init (e.g. Excalidraw) is
    // gated until the user explicitly switches modes via the host
    // picker. This is the behavior Claude exhibits.
    render(
      <ActiveMcpProfileProvider value={profileWith("user-initiated-only")}>
        <ChatboxHostStyleProvider value="claude">
          <MCPAppsRenderer {...baseProps} />
        </ChatboxHostStyleProvider>
      </ActiveMcpProfileProvider>
    );
    await vi.waitFor(() => {
      expect(mockBridge.onrequestdisplaymode).not.toBeNull();
    });
    const handler = mockBridge.onrequestdisplaymode as unknown as (args: {
      mode: "inline" | "fullscreen" | "pip";
    }) => Promise<{ mode: string }>;
    const result = await handler({ mode: "fullscreen" });
    expect(result.mode).toBe("inline");
  });
});

describe("MCPAppsRenderer requestTeardown policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHostContextStoreState.draftHostContext = {};
    Object.assign(mockPreferencesState, {
      themeMode: "light",
      hostStyle: "claude",
    });
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: false,
      mcpAppsCspMode: "permissive",
      globals: { locale: "en-US", timeZone: "UTC" },
      displayMode: "inline",
      capabilities: { hover: true, touch: false },
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      deviceType: "desktop",
    });
    mockBridge.oninitialized = null;
    mockBridge.onmessage = null;
    mockBridge.onopenlink = null;
    mockBridge.oncalltool = null;
    mockBridge.onreadresource = null;
    mockBridge.onlistresources = null;
    mockBridge.onlistresourcetemplates = null;
    mockBridge.onlistprompts = null;
    mockBridge.onloggingmessage = null;
    mockBridge.onsizechange = null;
    mockBridge.onrequestdisplaymode = null;
    mockBridge.onupdatemodelcontext = null;
    mockBridge.onrequestteardown = null;
    sandboxedIframePropsRef.current = null;
    sandboxedIframeElementRef.current = null;
    sandboxedIframeMountsRef.current = 0;
    sandboxedIframeUnmountsRef.current = 0;
    sandboxProxyBehaviorRef.current.autoReady = true;
    appBridgeArgsRef.current = null;

    vi.mocked(authFetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          html: "<html><body>live-widget</body></html>",
          csp: {
            connectDomains: ["https://api.example.com"],
            resourceDomains: ["https://cdn.example.com"],
            frameDomains: [],
            baseUriDomains: [],
          },
          permissions: { camera: true },
          permissive: false,
          mimeTypeValid: true,
          prefersBorder: true,
        }),
      status: 200,
      headers: new Headers(),
    } as Response);
  });

  const profileWithRequestTeardown = (
    requestTeardown: boolean
  ): HostConfigMcpProfileV1 => ({
    profileVersion: 1,
    apps: { mcpAppsOverrides: { requestTeardown } },
  });

  it("runs resource teardown and notifies the parent when enabled", async () => {
    const onRequestTeardown = vi.fn();
    render(
      <ActiveMcpProfileProvider value={profileWithRequestTeardown(true)}>
        <ChatboxHostStyleProvider value="claude">
          <MCPAppsRenderer
            {...baseProps}
            onRequestTeardown={onRequestTeardown}
          />
        </ChatboxHostStyleProvider>
      </ActiveMcpProfileProvider>
    );

    await vi.waitFor(() => {
      expect(mockBridge.onrequestteardown).not.toBeNull();
    });

    await act(async () => {
      await mockBridge.onrequestteardown();
    });

    expect(mockBridge.teardownResource).toHaveBeenCalledWith({});
    // Non-persistent path: displayWidgetId falls back to toolCallId.
    expect(onRequestTeardown).toHaveBeenCalledWith("call-1", "call-1");
  });

  it("forwards the persistent surface id alongside the tool call id on teardown", async () => {
    const onRequestTeardown = vi.fn();
    render(
      <WidgetSurfaceHostProvider>
        <ActiveMcpProfileProvider value={profileWithRequestTeardown(true)}>
          <ChatboxHostStyleProvider value="claude">
            <MCPAppsRenderer
              {...baseProps}
              onRequestTeardown={onRequestTeardown}
            />
            <WidgetSurfaceHost />
          </ChatboxHostStyleProvider>
        </ActiveMcpProfileProvider>
      </WidgetSurfaceHostProvider>
    );

    await vi.waitFor(() => {
      expect(mockBridge.onrequestteardown).not.toBeNull();
    });

    await act(async () => {
      await mockBridge.onrequestteardown();
    });

    expect(onRequestTeardown).toHaveBeenCalledTimes(1);
    const [calledToolCallId, calledDisplayWidgetId] =
      onRequestTeardown.mock.calls[0]!;
    expect(calledToolCallId).toBe("call-1");
    // Persistent path mints a surface id distinct from the tool call id;
    // Thread.handleRequestTeardown needs it to clear stuck fullscreen/PiP.
    expect(typeof calledDisplayWidgetId).toBe("string");
    expect(calledDisplayWidgetId).not.toBe("call-1");
  });

  it("leaves request teardown unhandled when disabled", async () => {
    render(
      <ActiveMcpProfileProvider value={profileWithRequestTeardown(false)}>
        <ChatboxHostStyleProvider value="claude">
          <MCPAppsRenderer {...baseProps} />
        </ChatboxHostStyleProvider>
      </ActiveMcpProfileProvider>
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(mockBridge.onrequestteardown).toBeNull();
  });
});
