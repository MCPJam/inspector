import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, screen, fireEvent } from "@testing-library/react";
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
    setWidgetAppliedCsp: vi.fn(),
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
// The renderer relocated to @mcpjam/widget-react imports `./sandboxed-iframe`
// (package-internal), so the mock must target the package module — the inspector
// `@/components/ui/sandboxed-iframe` path is now only a re-export shim and no
// longer intercepts the renderer's import.
vi.mock("../../../../../../../../widget-react/src/sandboxed-iframe", () => ({
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

vi.mock("@/stores/widget-debug-store", () => {
  const state = {
    setWidgetDebugInfo: stableStoreFns.setWidgetDebugInfo,
    setWidgetGlobals: stableStoreFns.setWidgetGlobals,
    setWidgetCsp: stableStoreFns.setWidgetCsp,
    setWidgetAppliedCsp: stableStoreFns.setWidgetAppliedCsp,
    addCspViolation: stableStoreFns.addCspViolation,
    clearCspViolations: stableStoreFns.clearCspViolations,
    setWidgetModelContext: stableStoreFns.setWidgetModelContext,
    setWidgetHtml: stableStoreFns.setWidgetHtml,
    setSandboxApplied: stableStoreFns.setSandboxApplied,
    appendLifecycle: stableStoreFns.appendLifecycle,
    recordMount: stableStoreFns.recordMount,
    widgets: new Map(),
  };
  return {
    useWidgetDebugStore: Object.assign((selector: any) => selector(state), {
      getState: () => state,
    }),
  };
});

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
  ExternalLink: (props: any) => <div {...props} />,
  X: (props: any) => <div {...props} />,
}));

// Capture props passed into the modal so tests can assert inline/modal
// HostCapabilities parity without mounting a real second AppBridge.
const mcpAppsModalPropsRef: { current: Record<string, unknown> | null } = {
  current: null,
};
// The modal relocated to @mcpjam/widget-react too; mock the package module so the
// real design-system <Dialog> is never mounted in these unit tests.
vi.mock("../../../../../../../../widget-react/src/mcp-apps-modal", () => ({
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
  ScenarioHostStyleProvider,
  ScenarioHostThemeProvider,
} from "@/contexts/scenario-client-style-context";
import { ScenarioHostCapabilitiesOverrideProvider } from "@/contexts/scenario-client-capabilities-override-context";
import { ActiveMcpProfileProvider } from "@/contexts/active-mcp-profile-context";
import { WidgetSurfaceProvider } from "@/contexts/widget-surface-context";
import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { HostConfigMcpProfileV1 } from "@/lib/client-config-v2";
import { InspectorWidgetHostProvider } from "../use-widget-host";

// The renderer relocated to @mcpjam/widget-react reads its host through the
// package `useWidgetHost()` context. Wrap each mount in the inspector's provider
// boundary — INSIDE any per-test inline context providers, so the host the
// boundary composes still reflects those overrides. `HostedRenderer` /
// `HostedSurfaceHost` are drop-in stand-ins for `<MCPAppsRenderer>` /
// `<WidgetSurfaceHost>` used throughout the assertions below.
function HostedRenderer(props: React.ComponentProps<typeof MCPAppsRenderer>) {
  return (
    <InspectorWidgetHostProvider>
      <MCPAppsRenderer {...props} />
    </InspectorWidgetHostProvider>
  );
}

function HostedSurfaceHost(
  props: React.ComponentProps<typeof WidgetSurfaceHost>,
) {
  return (
    <InspectorWidgetHostProvider>
      <WidgetSurfaceHost {...props} />
    </InspectorWidgetHostProvider>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────
const baseProps = {
  serverId: "server-1",
  serverName: "test-server",
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
      <HostedRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        widgetCsp={{
          connectDomains: ["https://ignored.example.com"],
          resourceDomains: ["https://ignored.example.com"],
          frameDomains: [],
          baseUriDomains: [],
        }}
        widgetPermissions={{ microphone: true } as any}
      />,
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>",
      );
    });

    expect(sandboxedIframePropsRef.current?.permissive).toBe(true);
    expect(sandboxedIframePropsRef.current?.csp).toBeUndefined();
    expect(sandboxedIframePropsRef.current?.permissions).toBeUndefined();
  });

  it("advertises hostCapabilities from the active host style preset (claude)", async () => {
    render(
      <ScenarioHostStyleProvider value="claude">
        <HostedRenderer {...baseProps} />
      </ScenarioHostStyleProvider>,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    // Should advertise Claude's preset, not the old empty literal.
    expect(appBridgeArgsRef.current?.hostCapabilities).toEqual(
      expect.objectContaining(getHostCapabilitiesForStyle("claude")),
    );
  });

  it("keeps the iframe and bridge alive when only the tool call id changes", async () => {
    const { rerender } = render(<HostedRenderer {...baseProps} />);

    await vi.waitFor(() => {
      expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("sandboxed-iframe")).toBeInTheDocument();
    });

    expect(sandboxedIframeMountsRef.current).toBe(1);

    act(() => triggerReady());

    rerender(
      <HostedRenderer
        {...baseProps}
        toolCallId="call-2"
        toolOutput={{ content: [{ type: "text" as const, text: "next" }] }}
      />,
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
        <HostedRenderer {...baseProps} />
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
      <ScenarioHostCapabilitiesOverrideProvider
        value={{ openLinks: {}, logging: {}, serverTools: {} }}
      >
        <HostedRenderer {...baseProps} />
      </ScenarioHostCapabilitiesOverrideProvider>
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

  it("renders separate iframes for distinct tool calls on the same widget", async () => {
    const firstOutput = { content: [{ type: "text" as const, text: "first" }] };
    const secondOutput = {
      content: [{ type: "text" as const, text: "second" }],
    };
    const renderTree = (includeSecondCall: boolean) => (
      <WidgetSurfaceHostProvider>
        <HostedRenderer
          {...baseProps}
          toolCallId="call-1"
          toolInput={{ move: "e4" }}
          toolOutput={firstOutput}
        />
        {includeSecondCall ? (
          <HostedRenderer
            {...baseProps}
            toolCallId="call-2"
            toolInput={{ move: "c5" }}
            toolOutput={secondOutput}
          />
        ) : null}
        <HostedSurfaceHost />
      </WidgetSurfaceHostProvider>
    );

    const { rerender } = render(renderTree(false));

    await vi.waitFor(() => {
      expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("sandboxed-iframe")).toBeInTheDocument();
    });

    act(() => triggerReady());

    await vi.waitFor(() => {
      expect(mockBridge.sendToolInput).toHaveBeenCalledTimes(1);
      expect(mockBridge.sendToolInput).toHaveBeenCalledWith({
        arguments: { move: "e4" },
      });
      expect(mockBridge.sendToolResult).toHaveBeenCalledTimes(1);
    });

    rerender(renderTree(true));

    // Each tool call is a semantically distinct View (SEP-1865 lifecycle):
    // call-2 must mount its own iframe under its own row instead of
    // collapsing into call-1's surface and leaving call-2's row empty.
    await vi.waitFor(() => {
      expect(mockAppBridgeCtor).toHaveBeenCalledTimes(2);
      expect(sandboxedIframeMountsRef.current).toBe(2);
      const anchors = Array.from(
        document.querySelectorAll("[data-mcp-app-surface-container]"),
      ).map((node) =>
        node.parentElement?.getAttribute("data-mcp-app-surface-anchor"),
      );
      expect(anchors).toContain("call-1");
      expect(anchors).toContain("call-2");
    });
  });

  it("mounts a separate live-preferred surface per cached tool call", async () => {
    render(
      <WidgetSurfaceHostProvider>
        <HostedRenderer
          {...baseProps}
          toolCallId="call-1"
          cachedWidgetHtmlUrl="blob:cached"
          liveFetchPreferred
        />
        <HostedRenderer
          {...baseProps}
          toolCallId="call-2"
          cachedWidgetHtmlUrl="blob:cached"
          liveFetchPreferred
          toolOutput={{ content: [{ type: "text" as const, text: "next" }] }}
        />
        <HostedSurfaceHost />
      </WidgetSurfaceHostProvider>,
    );

    // Live-preferred path bypasses cached blob — both tool calls trigger a
    // live fetch and each mounts its own iframe in its own row.
    await vi.waitFor(() => {
      expect(mockAppBridgeCtor).toHaveBeenCalledTimes(2);
      expect(sandboxedIframeMountsRef.current).toBe(2);
    });

    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalledWith("blob:cached");
  });

  it("keeps an already-live persistent surface when a cached snapshot URL arrives", async () => {
    const renderTree = (cachedWidgetHtmlUrl?: string) => (
      <WidgetSurfaceHostProvider>
        <HostedRenderer
          {...baseProps}
          {...(cachedWidgetHtmlUrl ? { cachedWidgetHtmlUrl } : {})}
        />
        <HostedSurfaceHost />
      </WidgetSurfaceHostProvider>
    );

    const { rerender } = render(renderTree());

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>live-widget</body></html>",
      );
    });

    const liveHtml = sandboxedIframePropsRef.current?.html;
    expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
    expect(sandboxedIframeMountsRef.current).toBe(1);
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);

    vi.mocked(global.fetch).mockClear();
    rerender(renderTree("blob:cached"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(sandboxedIframePropsRef.current?.html).toBe(liveHtml);
    expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
    expect(sandboxedIframeMountsRef.current).toBe(1);
    expect(sandboxedIframeUnmountsRef.current).toBe(0);
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalledWith("blob:cached");
  });

  it("mounts a fresh surface when the same row is re-keyed with a new tool call id", async () => {
    const sameOutput = { content: [{ type: "text" as const, text: "same" }] };
    const renderTree = (toolCallId: string) => (
      <WidgetSurfaceHostProvider>
        <HostedRenderer
          {...baseProps}
          toolCallId={toolCallId}
          toolOutput={sameOutput}
        />
        <HostedSurfaceHost />
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

    // Distinct tool call ⇒ distinct View. The previous surface tears
    // down and a fresh one mounts for call-2.
    await vi.waitFor(() => {
      expect(mockAppBridgeCtor).toHaveBeenCalledTimes(2);
      expect(sandboxedIframeMountsRef.current).toBe(2);
    });
  });

  it("keeps the iframe alive when the same tool call anchor is re-keyed", async () => {
    const renderTree = (showCall: boolean) => (
      <WidgetSurfaceHostProvider>
        {showCall ? (
          <HostedRenderer {...baseProps} toolCallId="call-1" />
        ) : null}
        <HostedSurfaceHost />
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
        <HostedRenderer
          {...baseProps}
          toolCallId="call-1"
          displayMode="fullscreen"
          fullscreenWidgetId="call-1"
        />
        <HostedSurfaceHost />
      </WidgetSurfaceHostProvider>,
    );

    await vi.waitFor(() => {
      expect(mockAppBridgeCtor).toHaveBeenCalledTimes(1);
    });

    expect(appBridgeArgsRef.current?.options?.hostContext?.displayMode).toBe(
      "fullscreen",
    );
    expect(mockBridge.close).not.toHaveBeenCalled();
    expect(mockBridge.teardownResource).not.toHaveBeenCalled();
    expect(sandboxedIframeMountsRef.current).toBe(1);
  });

  it("uses window.openai.setOpenInAppUrl messages for the fullscreen Open in button", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <HostedRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="fullscreen"
        fullscreenWidgetId="call-1"
      />,
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.onMessage).toBeTypeOf("function");
    });
    expect(
      screen.queryByRole("button", { name: "Open in test-server" }),
    ).not.toBeInTheDocument();

    act(() => {
      sandboxedIframePropsRef.current.onMessage({
        data: {
          type: "openai:setOpenInAppUrl",
          toolId: "call-1",
          href: "https://app.example.com/trails/42",
        },
      } as MessageEvent);
    });

    const button = screen.getByRole("button", { name: "Open in test-server" });
    expect(screen.getAllByText("test-server").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("test-tool")).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(openSpy).toHaveBeenCalledWith(
      "https://app.example.com/trails/42",
      "_blank",
      "noopener,noreferrer",
    );
    openSpy.mockRestore();
  });

  it("does not show the Open in button in contained phone fullscreen", async () => {
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: true,
      displayMode: "fullscreen",
      deviceType: "mobile",
    });

    render(
      <HostedRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="fullscreen"
        fullscreenWidgetId="call-1"
      />,
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.onMessage).toBeTypeOf("function");
    });

    act(() => {
      sandboxedIframePropsRef.current.onMessage({
        data: {
          type: "openai:setOpenInAppUrl",
          toolId: "call-1",
          href: "https://app.example.com/mobile",
        },
      } as MessageEvent);
    });

    expect(
      screen.queryByRole("button", { name: "Open in test-server" }),
    ).not.toBeInTheDocument();
  });

  it("ignores unsafe and capability-denied setOpenInAppUrl messages", async () => {
    const disabledProfile: HostConfigMcpProfileV1 = {
      profileVersion: 1,
      apps: {
        compatRuntime: {
          openaiApps: true,
          openaiAppsOverrides: { setOpenInAppUrl: false },
        },
      },
    };

    const { rerender } = render(
      <HostedRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="fullscreen"
        fullscreenWidgetId="call-1"
      />,
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.onMessage).toBeTypeOf("function");
    });

    act(() => {
      sandboxedIframePropsRef.current.onMessage({
        data: {
          type: "openai:setOpenInAppUrl",
          toolId: "call-1",
          href: "javascript:alert(1)",
        },
      } as MessageEvent);
    });
    expect(
      screen.queryByRole("button", { name: "Open in test-server" }),
    ).not.toBeInTheDocument();

    rerender(
      <ActiveMcpProfileProvider value={disabledProfile}>
        <HostedRenderer
          {...baseProps}
          cachedWidgetHtmlUrl="blob:cached"
          displayMode="fullscreen"
          fullscreenWidgetId="call-1"
        />
      </ActiveMcpProfileProvider>,
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.onMessage).toBeTypeOf("function");
    });

    act(() => {
      sandboxedIframePropsRef.current.onMessage({
        data: {
          type: "openai:setOpenInAppUrl",
          toolId: "call-1",
          href: "https://app.example.com/denied",
        },
      } as MessageEvent);
    });
    expect(
      screen.queryByRole("button", { name: "Open in test-server" }),
    ).not.toBeInTheDocument();
  });

  it("falls back to the spec-default 'no claims' blob when no style is resolvable", async () => {
    // No ScenarioHostStyleProvider, isPlaygroundActive is false in this test
    // setup, so effectiveHostStyle is null. The resolver MUST NOT silently
    // impersonate Claude here — it returns the spec-default {}.
    render(<HostedRenderer {...baseProps} />);

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    const { sandbox: _sandbox, ...vendorOnly } =
      appBridgeArgsRef.current?.hostCapabilities ?? {};
    expect(vendorOnly).toEqual({});
  });

  it("uses ChatGPT's current advertised hostCapabilities", async () => {
    render(
      <ScenarioHostStyleProvider value="chatgpt">
        <ScenarioHostThemeProvider value="dark">
          <HostedRenderer {...baseProps} />
        </ScenarioHostThemeProvider>
      </ScenarioHostStyleProvider>,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(appBridgeArgsRef.current?.hostCapabilities).toEqual(
      expect.objectContaining(getHostCapabilitiesForStyle("chatgpt")),
    );
    const advertised = appBridgeArgsRef.current?.hostCapabilities;
    expect(advertised).toHaveProperty("serverResources");
    expect(advertised).toHaveProperty("logging");
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
      <ScenarioHostStyleProvider value="copilot">
        <HostedRenderer {...baseProps} />
      </ScenarioHostStyleProvider>,
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
      <ScenarioHostStyleProvider value="claude">
        <HostedRenderer {...baseProps} />
      </ScenarioHostStyleProvider>,
    );
    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    const hostContext = appBridgeArgsRef.current?.options?.hostContext as
      | Record<string, unknown>
      | undefined;
    expect(hostContext).toHaveProperty("toolInfo");
    expect(
      (hostContext?.toolInfo as { tool: { name: string } }).tool.name,
    ).toBe("test-tool");
  });

  it("omits HostContext.toolInfo entirely when the matrix has toolInfo: false (Copilot)", async () => {
    // Microsoft 365 Copilot doesn't deliver `app.getHostContext()?.toolInfo`
    // per its published Component-bridge table. A widget that probes
    // for that field must see undefined — same as real Copilot.
    render(
      <ScenarioHostStyleProvider value="copilot">
        <HostedRenderer {...baseProps} />
      </ScenarioHostStyleProvider>,
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
      <ScenarioHostStyleProvider value="copilot">
        <HostedRenderer {...baseProps} />
      </ScenarioHostStyleProvider>,
    );
    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    const hostContext = appBridgeArgsRef.current?.options?.hostContext as
      | Record<string, unknown>
      | undefined;
    expect(hostContext).not.toHaveProperty("toolInfo");
  });

  it("advertises matrix-clamped HostContext.availableDisplayModes (Copilot: inline + fullscreen, no pip)", async () => {
    // Copilot's published Component-bridge table says requestDisplayMode
    // is supported "fullscreen only" — fullscreen is the only expansion a
    // widget may request, not that inline is unavailable. Copilot renders
    // widgets inline by default, so the host advertises
    // ["inline", "fullscreen"] (dropping the inspector's permissive pip).
    render(
      <ScenarioHostStyleProvider value="copilot">
        <HostedRenderer {...baseProps} />
      </ScenarioHostStyleProvider>,
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
    ]);
  });

  it("advertises Claude's probed inline and fullscreen modes", async () => {
    render(
      <ScenarioHostStyleProvider value="claude">
        <HostedRenderer {...baseProps} />
      </ScenarioHostStyleProvider>,
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
    ]);
  });

  it("clamps HostContext.displayMode to the matrix allowlist (Copilot in pip parent state coerces to inline)", async () => {
    // Regression: previously the matrix-clamped allowlist was only
    // written into `HostContext.availableDisplayModes`, but
    // `effectiveDisplayMode` was still computed against the
    // playground/configured allowlist alone. A Copilot host could
    // initialize or remain in `pip` if the parent's display state
    // was sticky `"pip"` from a previous widget, while advertising a
    // narrower allowlist — an inconsistent HostContext. Fix clamps the
    // displayMode against the matrix too. Copilot's matrix is
    // ["inline", "fullscreen"], so an unsupported pip coerces to the
    // first allowed mode (inline), not fullscreen.
    render(
      <ScenarioHostStyleProvider value="copilot">
        <HostedRenderer {...baseProps} displayMode="pip" pipWidgetId="call-1" />
      </ScenarioHostStyleProvider>,
    );
    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    const hostContext = appBridgeArgsRef.current?.options?.hostContext as
      | Record<string, unknown>
      | undefined;
    // Matrix-clamped: pip isn't allowed, so it coerces to inline (matrix[0]).
    expect(hostContext?.availableDisplayModes).toEqual([
      "inline",
      "fullscreen",
    ]);
    expect(hostContext?.displayMode).toBe("inline");
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
        <ScenarioHostStyleProvider value="claude">
          <HostedRenderer
            {...baseProps}
            displayMode="fullscreen"
            fullscreenWidgetId="call-1"
          />
        </ScenarioHostStyleProvider>
      </ActiveMcpProfileProvider>,
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
      <ScenarioHostStyleProvider value="copilot">
        <HostedRenderer {...baseProps} />
      </ScenarioHostStyleProvider>,
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

  it("preserves frameDomains and baseUriDomains on Cursor", async () => {
    // Counter-test: same CSP, but Cursor's matrix honors both sub-
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
      <ScenarioHostStyleProvider value="cursor">
        <HostedRenderer {...baseProps} />
      </ScenarioHostStyleProvider>,
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

  it("forwards one resolved subtype policy to inline and modal sandboxes", async () => {
    mcpAppsModalPropsRef.current = null;
    render(
      <ScenarioHostStyleProvider value="chatgpt">
        <HostedRenderer {...baseProps} />
      </ScenarioHostStyleProvider>,
    );
    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.cspSubtypePolicy).toBeDefined();
      expect(mcpAppsModalPropsRef.current).not.toBeNull();
    });
    // ChatGPT honors the declared connect list (one directive, proven by the
    // declared wss endpoint connecting while an undeclared one was blocked).
    // Its resource subtypes were unknown until the 2026-08-23 paired probe
    // declared `fastly.jsdelivr.net` — outside ChatGPT's baseline allowlist —
    // and every subtype loaded, so they are now measured-true rather than
    // absent.
    const expected = {
      cspConnectDomains: { fetch: true, xhr: true, websocket: true },
      cspResourceDomains: {
        script: true,
        stylesheet: true,
        image: true,
        font: true,
        media: true,
      },
    };
    expect(sandboxedIframePropsRef.current.cspSubtypePolicy).toEqual(expected);
    expect(mcpAppsModalPropsRef.current?.widgetCspSubtypePolicy).toEqual(
      expected,
    );
  });

  it("forwards browserStorage to inline and modal sandboxes, unchanged", async () => {
    mcpAppsModalPropsRef.current = null;
    const profile: HostConfigMcpProfileV1 = {
      profileVersion: 1,
      apps: { sandbox: { browserStorage: { localStorage: false } } },
    };
    render(
      <ActiveMcpProfileProvider value={profile}>
        <HostedRenderer {...baseProps} />
      </ActiveMcpProfileProvider>,
    );
    await vi.waitFor(() => {
      expect(mcpAppsModalPropsRef.current).not.toBeNull();
    });
    // Passed through verbatim: the proxy, not the renderer, decides what a
    // `false` leaf means. Both surfaces must agree — a widget moved to the
    // modal cannot regain an API the inline frame denied it.
    const expected = { localStorage: false };
    expect(sandboxedIframePropsRef.current.browserStorage).toEqual(expected);
    expect(mcpAppsModalPropsRef.current?.widgetBrowserStorage).toEqual(
      expected,
    );
  });

  it("leaves browserStorage undefined when the profile never mentions it", async () => {
    render(<HostedRenderer {...baseProps} />);
    await vi.waitFor(() => {
      expect(screen.getByTestId("sandboxed-iframe")).toBeInTheDocument();
    });
    // Absent must stay absent all the way to the proxy — an empty object
    // would arm the guard machinery for a host nobody probed.
    expect(sandboxedIframePropsRef.current.browserStorage).toBeUndefined();
  });

  it("keeps a permissive replay permissive when the host's subtype policy allows everything", async () => {
    // Claude and Cursor ship all-true subtype matrices. Those restrict
    // nothing, so treating the policy's mere presence as a host restriction
    // flipped `permissive` off and handed the proxy an undefined CSP — which
    // falls back to the locked-down policy (`connect-src 'none'`,
    // `img-src data:`) and breaks the replayed widget.
    render(
      <ScenarioHostStyleProvider value="claude">
        <HostedRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />
      </ScenarioHostStyleProvider>,
    );
    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>",
      );
    });
    expect(sandboxedIframePropsRef.current.cspSubtypePolicy).toEqual({
      cspConnectDomains: { fetch: true, xhr: true, websocket: true },
      cspResourceDomains: {
        script: true,
        stylesheet: true,
        image: true,
        font: true,
        media: true,
      },
    });
    expect(sandboxedIframePropsRef.current.permissive).toBe(true);
    expect(sandboxedIframePropsRef.current.csp).toBeUndefined();
  });

  it("locks a permissive replay down when the host actually blocks a subtype", async () => {
    // Counter-test: Goose blocks every connect subtype, so the emulation MUST
    // win over the widget's permissive flag. Guards against the fix above
    // disabling the feature outright.
    render(
      <ScenarioHostStyleProvider value="goose">
        <HostedRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />
      </ScenarioHostStyleProvider>,
    );
    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>",
      );
    });
    expect(sandboxedIframePropsRef.current.permissive).toBe(false);
  });

  it("bypasses subtype emulation for the explicit Playground permissive toggle", async () => {
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: true,
      mcpAppsCspMode: "permissive",
    });
    render(
      <WidgetSurfaceProvider value="playground">
        <ScenarioHostStyleProvider value="chatgpt">
          <HostedRenderer {...baseProps} />
        </ScenarioHostStyleProvider>
      </WidgetSurfaceProvider>,
    );
    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.permissive).toBe(true);
      expect(mcpAppsModalPropsRef.current).not.toBeNull();
    });
    expect(sandboxedIframePropsRef.current.cspSubtypePolicy).toBeUndefined();
    expect(
      mcpAppsModalPropsRef.current?.widgetCspSubtypePolicy,
    ).toBeUndefined();
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
      <ScenarioHostStyleProvider value="copilot">
        <HostedRenderer {...baseProps} />
      </ScenarioHostStyleProvider>,
    );
    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>",
      );
    });
    // Permissions cleared on Copilot — matches what real Copilot does
    // (it doesn't honor the widget's permission declarations at all).
    expect(
      sandboxedIframePropsRef.current?.permissions ?? undefined,
    ).toBeUndefined();
  });

  it("suppresses widget-declared permissions in the playground permissive escape hatch (Copilot)", async () => {
    // Regression: three review bots independently flagged the same
    // miss on #2242 — the `userTogglePermissive` branch (playground
    // + cspMode === "permissive" + non-scenario surface + non-
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
    // preferences-store `sharedHostStyle`, not the scenario provider
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
    // playground-vs-scenario-host-style routing wrinkle entirely:
    // the override path always wins regardless of which host style
    // is resolved.
    const copilotPermissionsOff: HostConfigMcpProfileV1 = {
      profileVersion: 1,
      apps: { mcpAppsOverrides: { sandboxPermissions: false } },
    };
    render(
      <ActiveMcpProfileProvider value={copilotPermissionsOff}>
        <HostedRenderer {...baseProps} />
      </ActiveMcpProfileProvider>,
    );
    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>",
      );
    });
    expect(
      sandboxedIframePropsRef.current?.permissions ?? undefined,
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
      <ScenarioHostStyleProvider value="claude">
        <HostedRenderer {...baseProps} />
      </ScenarioHostStyleProvider>,
    );
    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>",
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
      <ScenarioHostStyleProvider value="chatgpt">
        <HostedRenderer
          {...baseProps}
          toolState="input-streaming"
          toolInput={{ query: "yellow" }}
          toolOutput={undefined}
        />
      </ScenarioHostStyleProvider>,
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
      <ScenarioHostStyleProvider value="chatgpt">
        <HostedRenderer
          {...baseProps}
          toolState="input-streaming"
          toolInput={{ query: "yellow" }}
          toolOutput={undefined}
          toolMetadata={{ "openai/outputTemplate": "ui://widget/test.html" }}
        />
      </ScenarioHostStyleProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(authFetch).not.toHaveBeenCalled();
    expect(mockBridge.connect).not.toHaveBeenCalled();

    rerender(
      <ScenarioHostStyleProvider value="chatgpt">
        <HostedRenderer
          {...baseProps}
          toolState="output-available"
          toolInput={{ query: "yellow" }}
          toolOutput={{
            content: [{ type: "text", text: "done" }],
            structuredContent: { route: "Yellow-N" },
          }}
          toolMetadata={{ "openai/outputTemplate": "ui://widget/test.html" }}
        />
      </ScenarioHostStyleProvider>,
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
      <ScenarioHostStyleProvider value="chatgpt">
        <HostedRenderer
          {...baseProps}
          toolState="input-streaming"
          toolInput={{ query: "yellow" }}
          toolOutput={undefined}
          toolMetadata={{ "openai/outputTemplate": "ui://widget/test.html" }}
          cachedWidgetHtmlUrl="blob:cached"
          liveFetchPreferred
        />
      </ScenarioHostStyleProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(authFetch).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalledWith("blob:cached");
    expect(mockBridge.connect).not.toHaveBeenCalled();

    rerender(
      <ScenarioHostStyleProvider value="chatgpt">
        <HostedRenderer
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
      </ScenarioHostStyleProvider>,
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
      <ScenarioHostCapabilitiesOverrideProvider value={override}>
        <HostedRenderer {...baseProps} />
      </ScenarioHostCapabilitiesOverrideProvider>,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    const { sandbox: _sandbox, ...vendorOnly } =
      appBridgeArgsRef.current?.hostCapabilities ?? {};
    expect(vendorOnly).toEqual(override);
  });

  it("uses scenario host style for SEP-1865 host context outside the playground", async () => {
    render(
      <ScenarioHostStyleProvider value="chatgpt">
        <ScenarioHostThemeProvider value="dark">
          <HostedRenderer {...baseProps} />
        </ScenarioHostThemeProvider>
      </ScenarioHostStyleProvider>,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(
      appBridgeArgsRef.current?.options?.hostContext?.styles?.variables?.[
        "--color-background-primary"
      ],
    ).toBe(
      CHATGPT_HOST_STYLE.mcp.resolveStyleVariables("dark")[
        "--color-background-primary"
      ],
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
        }),
      );
    });
  });

  it("uses the current chat host theme for host context outside the playground", async () => {
    mockPreferencesState.themeMode = "light";
    mockHostContextStoreState.draftHostContext = {
      theme: "light",
    };

    render(
      <ScenarioHostStyleProvider value="claude">
        <ScenarioHostThemeProvider value="dark">
          <HostedRenderer {...baseProps} />
        </ScenarioHostThemeProvider>
      </ScenarioHostStyleProvider>,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(appBridgeArgsRef.current?.options?.hostContext?.theme).toBe("dark");
    expect(
      appBridgeArgsRef.current?.options?.hostContext?.styles?.variables?.[
        "--color-background-primary"
      ],
    ).toBe(
      CLAUDE_HOST_STYLE.mcp.resolveStyleVariables("dark")[
        "--color-background-primary"
      ],
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
        }),
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

    render(<HostedRenderer {...baseProps} />);

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
        }),
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

    render(<HostedRenderer {...baseProps} />);

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
        }),
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
      <ScenarioHostStyleProvider value="claude">
        <HostedRenderer {...baseProps} />
      </ScenarioHostStyleProvider>,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(
      appBridgeArgsRef.current?.options?.hostContext?.styles?.variables,
    ).toEqual(
      expect.objectContaining({
        "--color-background-primary":
          CLAUDE_HOST_STYLE.mcp.resolveStyleVariables("light")[
            "--color-background-primary"
          ],
        "--font-sans": "Custom Sans",
      }),
    );
    expect(
      appBridgeArgsRef.current?.options?.hostContext?.styles?.variables,
    ).not.toHaveProperty("--mcpjam-theme-preset");
    expect(
      appBridgeArgsRef.current?.options?.hostContext?.styles?.variables,
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
        }),
      );
    });
  });

  it("aligns the sandbox iframe with the host surface while providing host chrome", async () => {
    render(
      <ScenarioHostStyleProvider value="claude">
        <HostedRenderer {...baseProps} />
      </ScenarioHostStyleProvider>,
    );

    const iframe = await screen.findByTestId("sandboxed-iframe");
    const hostChrome = screen.getByTestId("mcp-app-host-chrome");

    expect(iframe.className).toContain("bg-transparent");
    expect(sandboxedIframePropsRef.current?.style?.backgroundColor).toBe(
      CLAUDE_HOST_STYLE.mcp.resolveStyleVariables("light")[
        "--color-background-primary"
      ],
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
      <ScenarioHostStyleProvider value="claude">
        <HostedRenderer {...baseProps} prefersBorder={false} />
      </ScenarioHostStyleProvider>,
    );

    const iframe = await screen.findByTestId("sandboxed-iframe");

    expect(screen.queryByTestId("mcp-app-host-chrome")).not.toBeInTheDocument();
    expect(iframe.className).toContain("bg-transparent");
    expect(iframe.className).not.toContain("border border-border/40");
    expect(sandboxedIframePropsRef.current?.style?.backgroundColor).toBe(
      CLAUDE_HOST_STYLE.chatUi.resolveChatBackground("light"),
    );
    expect(sandboxedIframePropsRef.current?.colorScheme).toBe("light");
  });

  it("anchors desktop playground PiP to the playground shell instead of the viewport", async () => {
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: true,
      displayMode: "pip",
      deviceType: "desktop",
    });
    mockPreferencesState.hostStyle = "mcpjam";

    render(
      <HostedRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="pip"
        pipWidgetId="call-1"
      />,
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
      <HostedRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="fullscreen"
        fullscreenWidgetId="call-1"
      />,
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
      <HostedRenderer
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
      <HostedRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="fullscreen"
        fullscreenWidgetId="call-1"
      />,
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
      <HostedRenderer
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
      <HostedRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="fullscreen"
        fullscreenWidgetId="call-1"
      />,
    );
    expect(sandboxedIframePropsRef.current?.style?.height).toBe("100%");

    act(() => {
      mockBridge.onsizechange?.({ width: 1200, height: 900 });
    });
    rerender(renderInline());

    expect(sandboxedIframePropsRef.current?.style?.height).toBe("300px");
  });

  it("keeps inline renderer width host-controlled when the app reports size", async () => {
    const renderInline = () => (
      <HostedRenderer
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
    rerender(renderInline());

    const hostChrome = screen.getByTestId("mcp-app-host-chrome");
    const container = hostChrome.parentElement as HTMLElement;
    expect(container.style.width).toBe("");
    expect(sandboxedIframePropsRef.current?.style?.height).toBe("300px");
    expect(sandboxedIframePropsRef.current?.style?.width).toBe("100%");

    rerender(renderInline());
    expect((hostChrome.parentElement as HTMLElement).style.width).toBe("");
    expect(sandboxedIframePropsRef.current?.style?.width).toBe("100%");
  });

  it("pushes updated host context when the project client profile changes", async () => {
    const { rerender } = render(<HostedRenderer {...baseProps} />);

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
        }),
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

    rerender(<HostedRenderer {...baseProps} />);

    await vi.waitFor(() => {
      expect(mockBridge.setHostContext).toHaveBeenLastCalledWith(
        expect.objectContaining({
          locale: "es-ES",
          timeZone: "Europe/Madrid",
          deviceCapabilities: {
            hover: false,
            touch: true,
          },
        }),
      );
    });
  });

  it("forces permissive replay for cached HTML even when strict replay metadata is stored", async () => {
    render(
      <HostedRenderer
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
      />,
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>",
      );
    });

    expect(sandboxedIframePropsRef.current?.permissive).toBe(true);
    expect(sandboxedIframePropsRef.current?.csp).toBeUndefined();
    expect(sandboxedIframePropsRef.current?.permissions).toBeUndefined();
  });

  it("forces permissive replay for cached HTML even when permissive replay metadata is stored", async () => {
    render(
      <HostedRenderer
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
      />,
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>",
      );
    });

    expect(sandboxedIframePropsRef.current?.permissive).toBe(true);
    expect(sandboxedIframePropsRef.current?.csp).toBeUndefined();
    expect(sandboxedIframePropsRef.current?.permissions).toBeUndefined();
  });

  it("keeps the live fetch path on server-declared strict widget settings", async () => {
    render(<HostedRenderer {...baseProps} />);

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>live-widget</body></html>",
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
      <HostedRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        liveFetchPreferred
      />,
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>live-widget</body></html>",
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
      <ScenarioHostStyleProvider value="chatgpt">
        <HostedRenderer
          {...baseProps}
          cachedWidgetHtmlUrl="blob:cached"
          liveFetchPreferred
          injectedOpenAiCompat={false}
          injectedOpenAiCompatCapabilities={{ callTool: false }}
        />
      </ScenarioHostStyleProvider>,
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
      new Error('Hosted server not found for "server-1"'),
    );

    render(
      <HostedRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        liveFetchPreferred
      />,
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>widget</body></html>",
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
        <HostedRenderer {...baseProps} />
      </WidgetSurfaceProvider>,
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

    render(<HostedRenderer {...baseProps} />);

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
      <HostedRenderer
        {...baseProps}
        resourceUri="mcp-app://stale"
        cachedWidgetHtmlUrl="blob:cached"
        liveFetchPreferred
      />,
    );

    // Wait for the stale fetch to start.
    await vi.waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
    });

    // Re-render with a new resource URI. This rotates the source-identity key.
    // A second live fetch is queued for the new key; we let it resolve
    // normally with the default authFetch mock.
    rerender(
      <HostedRenderer
        {...baseProps}
        resourceUri="mcp-app://fresh"
        cachedWidgetHtmlUrl="blob:cached"
        liveFetchPreferred
      />,
    );

    // Wait for the fresh fetch to complete and paint the sandbox.
    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.html).toBe(
        "<html><body>live-widget</body></html>",
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
      "<html><body>live-widget</body></html>",
    );
    expect(sandboxedIframePropsRef.current?.html).not.toContain(
      "STALE-CONTENT",
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
      <HostedRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        liveFetchPreferred
      />,
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
        }),
    );

    render(<HostedRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />);

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
        "<html><body>widget</body></html>",
      );
    });
  });

  it("waits for the sandbox proxy before starting the bridge handshake", async () => {
    sandboxProxyBehaviorRef.current.autoReady = false;

    render(<HostedRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />);

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
        undefined,
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
        "<html><body>widget</body></html>",
      );
    });
  });

  it("publishes the resolved sandbox payload + lifecycle into widget-debug-store", async () => {
    // Verifies the Phase 4 plumbing: as soon as the effectiveSandbox useMemo
    // settles, setSandboxApplied fires; as widget-content-* / bridge-* events
    // flow through logWidgetDebug, appendLifecycle fans them out into the
    // store's lifecycle array. This is the runtime feed the Sandbox debug
    // panel reads — if it stops happening the panel silently goes blank.
    render(<HostedRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />);

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
        null,
      );
    });

    await vi.waitFor(() => {
      // At least one lifecycle event from the renderer's existing
      // logWidgetDebug emissions made it through the bridge.
      expect(stableStoreFns.appendLifecycle).toHaveBeenCalled();
    });
  });

  it("records the view mount reported by the sandbox proxy", async () => {
    // The proxy posts `mcpjam:view-mode` once per mount. It has to land in
    // two places: the lifecycle list (so the panel shows the view came up)
    // and `applied` (so the Sandbox Stack chip can show the origin a
    // developer allowlists with a referrer-restricted third party). The
    // status is derived from the mode, not a method suffix.
    render(<HostedRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />);

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.onMessage).toBeTypeOf("function");
    });

    act(() => {
      sandboxedIframePropsRef.current.onMessage({
        data: {
          type: "mcpjam:view-mode",
          mode: "url",
          url: "http://127.0.0.1:6274/api/apps/mcp-apps/sandbox-proxy?v=1",
        },
      } as MessageEvent);
    });

    await vi.waitFor(() => {
      expect(stableStoreFns.appendLifecycle).toHaveBeenCalledWith(
        "call-1",
        expect.objectContaining({ kind: "view-mounted", status: "ok" }),
      );
    });

    await vi.waitFor(() => {
      expect(stableStoreFns.setSandboxApplied).toHaveBeenCalledWith(
        "call-1",
        expect.objectContaining({
          viewMode: "url",
          viewUrl: "http://127.0.0.1:6274/api/apps/mcp-apps/sandbox-proxy?v=1",
          assignedOrigin: "http://127.0.0.1:6274",
        }),
        undefined,
        null,
      );
    });
  });

  it("records CSP intent from the proxy with its applied mount", async () => {
    render(<HostedRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />);

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.onMessage).toBeTypeOf("function");
    });

    act(() => {
      sandboxedIframePropsRef.current.onMessage({
        data: {
          type: "mcpjam:csp-applied",
          mountId: "proxy-a:1",
          csp: "frame-src https://js.stripe.com",
          mode: "widget-declared",
          intent: {
            csp: { frameDomains: ["https://js.stripe.com"] },
            permissive: false,
          },
        },
      } as MessageEvent);
    });

    expect(stableStoreFns.setWidgetAppliedCsp).toHaveBeenCalledWith(
      expect.any(String),
      {
        mountId: "proxy-a:1",
        headerString: "frame-src https://js.stripe.com",
        mode: "widget-declared",
        intent: {
          csp: { frameDomains: ["https://js.stripe.com"] },
          cspDirectives: undefined,
          permissive: false,
        },
      },
    );
  });

  it("marks a srcdoc mount as a degraded view (no origin to allowlist)", async () => {
    render(<HostedRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />);

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.onMessage).toBeTypeOf("function");
    });

    act(() => {
      sandboxedIframePropsRef.current.onMessage({
        data: {
          type: "mcpjam:view-mode",
          mode: "srcdoc-fallback",
          url: "about:srcdoc",
        },
      } as MessageEvent);
    });

    await vi.waitFor(() => {
      expect(stableStoreFns.appendLifecycle).toHaveBeenCalledWith(
        "call-1",
        expect.objectContaining({ kind: "view-mounted", status: "error" }),
      );
    });

    await vi.waitFor(() => {
      expect(stableStoreFns.setSandboxApplied).toHaveBeenCalledWith(
        "call-1",
        expect.objectContaining({
          viewMode: "srcdoc-fallback",
          // `about:srcdoc` has no origin — the chip must not offer one.
          assignedOrigin: undefined,
        }),
        undefined,
        null,
      );
    });
  });

  it("publishes a declared ui.domain into the debug store", async () => {
    // The Workbench's origin card is the only place a developer learns their
    // `_meta.ui.domain` will not match what MCPJam serves, so the declaration
    // has to survive the trip from the widget-content response into the store.
    vi.mocked(authFetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          html: "<html><body>live-widget</body></html>",
          permissive: true,
          mimeTypeValid: true,
          declaredDomain: "abc123.claudemcpcontent.com",
        }),
      status: 200,
      headers: new Headers(),
    } as Response);

    render(<HostedRenderer {...baseProps} />);

    await vi.waitFor(() => {
      expect(stableStoreFns.setWidgetCsp).toHaveBeenCalledWith(
        "call-1",
        expect.objectContaining({
          declaredDomain: "abc123.claudemcpcontent.com",
          // Permissive, no csp, no permissions: without the declared domain
          // widening the guard, this record would never be written and the
          // panel would not render at all.
          mode: "permissive",
        }),
      );
    });
  });

  it("sends partial tool input during input-streaming", async () => {
    const partialInput = { elements: '[{"type":"rectangle"' };
    render(
      <HostedRenderer
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
      <HostedRenderer
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

    const iframe = screen.getByTestId("sandboxed-iframe") as HTMLElement;
    expect(iframe.style.opacity).toBe("0");
    expect(iframe.style.position).toBe("absolute");
    expect(iframe.style.pointerEvents).toBe("none");

    const partialInput = { elements: '[{"type":"rectangle"' };
    rerender(
      <HostedRenderer
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
      <HostedRenderer
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
      <HostedRenderer
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
      <HostedRenderer
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
      <HostedRenderer
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
      <HostedRenderer
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
      <HostedRenderer
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
      <HostedRenderer
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
      <HostedRenderer
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
      <HostedRenderer
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
      <HostedRenderer
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
      <HostedRenderer
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
    render(<HostedRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />);

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
      <HostedRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />,
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
      <HostedRenderer
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
      <HostedRenderer
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
      <HostedRenderer
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
    render(<HostedRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />);

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
      <HostedRenderer
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
      <HostedRenderer
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

  // ── Scenario surface × declared host profile ────────────────────────────
  // The "MCP Apps render blank in User Testing" regression. A scenario
  // surface forces `cspMode: "permissive"`; the server used to answer that
  // request by withholding the resource's declared CSP. Every host template
  // seeds `apps.sandbox.csp.mode: "declared"`, so `resolveSandboxCsp` then
  // ran with `resourceCsp: undefined`, fell back to the empty secure
  // default, and forced `permissive: false` — the sandbox proxy emitted
  // `script-src 'unsafe-inline' data: blob:` and every esm.sh module load
  // in the App was refused. The tester saw an empty bordered box.
  const declaredCspProfile = (): HostConfigMcpProfileV1 => ({
    profileVersion: 1,
    apps: { sandbox: { csp: { mode: "declared" } } },
  });

  it("keeps the resource-declared CSP on a scenario surface under a 'declared' host profile", async () => {
    // Server response as it now stands: a scenario surface asks for
    // permissive, and the route reports the declaration regardless.
    vi.mocked(authFetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          html: "<html><body>live-widget</body></html>",
          csp: {
            resourceDomains: ["https://esm.sh"],
            connectDomains: ["https://esm.sh"],
          },
          permissive: true,
          mimeTypeValid: true,
          prefersBorder: true,
        }),
      status: 200,
      headers: new Headers(),
    } as Response);

    render(
      <WidgetSurfaceProvider value="scenario">
        <ActiveMcpProfileProvider value={declaredCspProfile()}>
          <HostedRenderer {...baseProps} />
        </ActiveMcpProfileProvider>
      </WidgetSurfaceProvider>,
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.csp).toBeTruthy();
    });

    // Before the fix both lists came back `[]` — the empty secure default.
    expect(sandboxedIframePropsRef.current.csp.resourceDomains).toEqual([
      "https://esm.sh",
    ]);
    expect(sandboxedIframePropsRef.current.csp.connectDomains).toEqual([
      "https://esm.sh",
    ]);
    // The host policy is in force, so the meta-CSP is injected — with the
    // declared origins in it, which is the whole point.
    expect(sandboxedIframePropsRef.current.permissive).toBe(false);
  });

  it("keeps empty domain lists on a scenario surface when the App declares no CSP", async () => {
    // The inverse, and a spec MUST: "if `ui.csp` is omitted" the host keeps
    // the restrictive default, and "Host MAY further restrict but MUST NOT
    // allow undeclared domains." An undeclared App stays blocked — Change 3
    // makes that legible rather than blank.
    vi.mocked(authFetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          html: "<html><body>live-widget</body></html>",
          csp: undefined,
          permissive: true,
          mimeTypeValid: true,
          prefersBorder: true,
        }),
      status: 200,
      headers: new Headers(),
    } as Response);

    render(
      <WidgetSurfaceProvider value="scenario">
        <ActiveMcpProfileProvider value={declaredCspProfile()}>
          <HostedRenderer {...baseProps} />
        </ActiveMcpProfileProvider>
      </WidgetSurfaceProvider>,
    );

    await vi.waitFor(() => {
      expect(sandboxedIframePropsRef.current?.csp).toBeTruthy();
    });

    expect(sandboxedIframePropsRef.current.csp.resourceDomains).toEqual([]);
    expect(sandboxedIframePropsRef.current.csp.connectDomains).toEqual([]);
  });

  // ── Blocked-App notice ──────────────────────────────────────────────────
  // An App whose own resources are refused never signals ready, so the
  // iframe stays at `opacity: 0`. Without a notice that is indistinguishable
  // from a hang — the two-hour-investigation failure mode this replaces.
  const postCspViolation = (overrides: Record<string, unknown> = {}): void => {
    act(() => {
      sandboxedIframePropsRef.current.onMessage({
        data: {
          type: "mcp-apps:csp-violation",
          directive: "script-src-elem",
          effectiveDirective: "script-src-elem",
          blockedUri: "https://esm.sh/react@19",
          mountId: "proxy-a:7",
          originalPolicy: "default-src 'none'; script-src 'none'",
          disposition: "enforce",
          ...overrides,
        },
      } as MessageEvent);
    });
  };

  it("explains a CSP-blocked App that never signals ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<HostedRenderer {...baseProps} />);

      await vi.waitFor(() => {
        expect(sandboxedIframePropsRef.current?.onMessage).toBeTruthy();
      });

      postCspViolation();
      expect(stableStoreFns.addCspViolation).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          mountId: "proxy-a:7",
          originalPolicy: "default-src 'none'; script-src 'none'",
          disposition: "enforce",
        }),
      );
      // Grace period: the notice must not race a View that is merely slow.
      expect(screen.queryByTestId("mcp-app-csp-blocked-notice")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      const notice = screen.getByTestId("mcp-app-csp-blocked-notice");
      expect(notice.textContent).toContain("Content Security Policy");
      // Names the blocked directive and the first blocked origin — the two
      // facts that turn this into a five-second diagnosis.
      expect(notice.textContent).toContain("script-src-elem");
      expect(notice.textContent).toContain("https://esm.sh/react@19");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the blocked-App notice plain-language in minimal mode", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<HostedRenderer {...baseProps} minimalMode={true} />);

      await vi.waitFor(() => {
        expect(sandboxedIframePropsRef.current?.onMessage).toBeTruthy();
      });

      postCspViolation();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      const notice = screen.getByTestId("mcp-app-csp-blocked-notice");
      // Testers get a sentence, not a debug dump.
      expect(notice.textContent).toContain("couldn't load its resources");
      expect(notice.textContent).not.toContain("Content Security Policy");
      expect(notice.textContent).not.toContain("script-src-elem");
      expect(notice.textContent).toContain("https://esm.sh/react@19");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not show the blocked-App notice when the App boots anyway", async () => {
    // A blocked optional asset (an analytics beacon, a webfont) still
    // reports a violation. If the View initializes, there is nothing wrong
    // to report and the notice must never appear.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<HostedRenderer {...baseProps} />);

      await vi.waitFor(() => {
        expect(sandboxedIframePropsRef.current?.onMessage).toBeTruthy();
      });

      postCspViolation({ blockedUri: "https://analytics.example.com/beacon" });
      act(() => triggerReady());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(screen.queryByTestId("mcp-app-csp-blocked-notice")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not carry a blocked-App notice onto freshly committed HTML", async () => {
    // A violation belongs to the bytes that reported it. Once new HTML is
    // committed the notice must not keep explaining the old ones — it would
    // misdiagnose the new render outright if that failed for an unrelated
    // reason. Covers both the resource swap and a refetch under the same
    // identity, which the identity-keyed reset effect cannot see.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender } = render(<HostedRenderer {...baseProps} />);

      await vi.waitFor(() => {
        expect(sandboxedIframePropsRef.current?.onMessage).toBeTruthy();
      });

      postCspViolation({ blockedUri: "https://resource-a.example/app.js" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.getByTestId("mcp-app-csp-blocked-notice")).toBeTruthy();

      // Same renderer, different live resource.
      rerender(
        <HostedRenderer
          {...baseProps}
          toolCallId="call-2"
          resourceUri="mcp-app://other"
        />,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      // Nothing has been reported against the new bytes, so there is nothing
      // to explain about them.
      expect(screen.queryByTestId("mcp-app-csp-blocked-notice")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains a block after a TIGHTENED policy breaks a previously-working App", async () => {
    // End-to-end guard on the case the notice most needs to cover: the App
    // boots fine, the policy is then narrowed, and the reloaded App can't
    // initialize. This works because `effectiveSandboxKey` is a dependency
    // of the bridge-connect effect, which resets readiness when it re-runs —
    // pinning that here so a refactor that decouples the two (leaving
    // `isReady` true across a policy reload) turns the notice back into a
    // silent blank surface.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const renderTree = (connectDomains: string[]) => (
        <ActiveMcpProfileProvider
          value={{
            profileVersion: 1,
            apps: {
              sandbox: {
                csp: { mode: "declared", restrictTo: { connectDomains } },
              },
            },
          }}
        >
          <HostedRenderer {...baseProps} />
        </ActiveMcpProfileProvider>
      );

      const { rerender } = render(renderTree(["https://api.example.com"]));

      await vi.waitFor(() => {
        expect(sandboxedIframePropsRef.current?.onMessage).toBeTruthy();
      });
      act(() => triggerReady());

      // Narrow the policy — the iframe reloads and the App is now blocked.
      rerender(renderTree([]));
      await vi.waitFor(() => {
        expect(sandboxedIframePropsRef.current.csp.connectDomains).toEqual([]);
      });

      postCspViolation({ blockedUri: "https://api.example.com/data" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      const notice = screen.getByTestId("mcp-app-csp-blocked-notice");
      expect(notice.textContent).toContain("https://api.example.com/data");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a stale blocked-App notice when the sandbox policy changes", async () => {
    // Widening a profile to unblock an App re-posts the resource-ready
    // payload (SandboxedIframe keys it on the resolved csp), so the View
    // boots again. A violation recorded against the PREVIOUS policy must not
    // keep naming an origin that is now allowed.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const renderTree = (connectDomains: string[]) => (
        <ActiveMcpProfileProvider
          value={{
            profileVersion: 1,
            apps: {
              sandbox: {
                csp: { mode: "declared", restrictTo: { connectDomains } },
              },
            },
          }}
        >
          <HostedRenderer {...baseProps} />
        </ActiveMcpProfileProvider>
      );

      // `restrictTo` INTERSECTS the declared baseline, so the widened value
      // must be one the baseline actually contains — otherwise the resolved
      // policy is unchanged and no reload happens.
      const { rerender } = render(renderTree([]));

      await vi.waitFor(() => {
        expect(sandboxedIframePropsRef.current?.onMessage).toBeTruthy();
      });
      expect(sandboxedIframePropsRef.current.csp.connectDomains).toEqual([]);

      postCspViolation();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.getByTestId("mcp-app-csp-blocked-notice")).toBeTruthy();

      // Profile edit → new resolved CSP → iframe reload.
      rerender(renderTree(["https://api.example.com"]));

      await vi.waitFor(() => {
        expect(sandboxedIframePropsRef.current.csp.connectDomains).toEqual([
          "https://api.example.com",
        ]);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      // Stale violation dropped: nothing has been reported against the new
      // policy yet, so there is nothing to explain.
      expect(screen.queryByTestId("mcp-app-csp-blocked-notice")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
      <ScenarioHostCapabilitiesOverrideProvider value={{}}>
        <HostedRenderer {...baseProps} />
      </ScenarioHostCapabilitiesOverrideProvider>,
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
      <ScenarioHostCapabilitiesOverrideProvider value={{}}>
        <HostedRenderer {...baseProps} />
      </ScenarioHostCapabilitiesOverrideProvider>,
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
        <ScenarioHostCapabilitiesOverrideProvider value={{ [cap]: {} }}>
          <HostedRenderer {...baseProps} />
        </ScenarioHostCapabilitiesOverrideProvider>,
      );

      await vi.waitFor(() => {
        expect(mockBridge.connect).toHaveBeenCalled();
      });

      expect(mockBridge[handlerKey]).not.toBeNull();
    },
  );

  it("reports widget-initiated server tool calls for transcript rendering", async () => {
    const onCallTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "tool ok" }],
    });
    const onAppToolInvocationChange = vi.fn();

    render(
      <ScenarioHostCapabilitiesOverrideProvider value={{ serverTools: {} }}>
        <HostedRenderer
          {...baseProps}
          onCallTool={onCallTool}
          onAppToolInvocationChange={onAppToolInvocationChange}
        />
      </ScenarioHostCapabilitiesOverrideProvider>,
    );

    await vi.waitFor(() => {
      expect(mockBridge.oncalltool).not.toBeNull();
    });

    await act(async () => {
      await mockBridge.oncalltool({
        name: "transparency-test",
        arguments: { value: 1 },
      });
    });

    expect(onCallTool).toHaveBeenCalledWith("transparency-test", { value: 1 });
    expect(onAppToolInvocationChange).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: "call-1:app-tool:0",
        parentToolCallId: "call-1",
        toolName: "transparency-test",
        input: { value: 1 },
        status: "running",
      }),
    );
    expect(onAppToolInvocationChange).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: "call-1:app-tool:0",
        parentToolCallId: "call-1",
        toolName: "transparency-test",
        input: { value: 1 },
        output: { content: [{ type: "text", text: "tool ok" }] },
        status: "success",
      }),
    );
  });

  it("registers all three serverResources handlers under a single cap", async () => {
    render(
      <ScenarioHostCapabilitiesOverrideProvider value={{ serverResources: {} }}>
        <HostedRenderer {...baseProps} />
      </ScenarioHostCapabilitiesOverrideProvider>,
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
      <ScenarioHostCapabilitiesOverrideProvider value={{ openLinks: {} }}>
        <HostedRenderer {...baseProps} />
      </ScenarioHostCapabilitiesOverrideProvider>,
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
    policy: "accept" | "user-initiated-only" | "decline",
  ): HostConfigMcpProfileV1 => ({
    profileVersion: 1,
    apps: { mcpAppsOverrides: { widgetDisplayModeRequests: policy } },
  });

  it("accept: grants the widget's fullscreen request", async () => {
    render(
      <ActiveMcpProfileProvider value={profileWith("accept")}>
        <ScenarioHostStyleProvider value="claude">
          <HostedRenderer {...baseProps} />
        </ScenarioHostStyleProvider>
      </ActiveMcpProfileProvider>,
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
        <ScenarioHostStyleProvider value="claude">
          <HostedRenderer {...baseProps} />
        </ScenarioHostStyleProvider>
      </ActiveMcpProfileProvider>,
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
        <ScenarioHostStyleProvider value="claude">
          <HostedRenderer {...baseProps} />
        </ScenarioHostStyleProvider>
      </ActiveMcpProfileProvider>,
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

// SEP-1865 regression: the sticky inline preference set by the host's own
// close chrome (the X on PIP / fullscreen) must gate widget-initiated
// `ui/request-display-mode` under `user-initiated-only` ONLY. Applying it
// under `accept` meant one X click permanently muted the widget's display
// mode requests — an app's own PIP / fullscreen / inline buttons went dead
// for the rest of that widget's life, recoverable only via the host picker.
//
// These drive the renderer in CONTROLLED mode (the shape Thread uses), so
// the assertions cover the real transition — the mode returned to the
// widget, the mode published in HostContext, and the parent's
// fullscreen/PIP ownership ids — not just the handler's return value.
describe("MCPAppsRenderer display-mode requests after a user close", () => {
  beforeEach(() => {
    mockHostContextStoreState.draftHostContext = {};
    Object.assign(mockPreferencesState, {
      themeMode: "light",
      hostStyle: "mcpjam",
    });
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: true,
      mcpAppsCspMode: "permissive",
      globals: { locale: "en-US", timeZone: "UTC" },
      displayMode: "inline",
      capabilities: { hover: true, touch: false },
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      // Desktop keeps PIP a distinct mode; the handler coerces PIP to
      // fullscreen on mobile / tablet surfaces.
      deviceType: "desktop",
    });
    mockBridge.connect.mockClear().mockResolvedValue(undefined);
    mockBridge.close.mockClear().mockResolvedValue(undefined);
    mockBridge.teardownResource.mockClear().mockResolvedValue({});
    // The app declares every mode, so the host ∩ app intersection can't be
    // what refuses a request in these cases.
    mockBridge.getAppCapabilities.mockReturnValue({
      availableDisplayModes: ["inline", "fullscreen", "pip"],
    });
    mockBridge.oninitialized = null;
    mockBridge.onrequestdisplaymode = null;
    mockBridge.setHostContext.mockClear();
    sandboxProxyBehaviorRef.current.autoReady = true;
    vi.mocked(authFetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          html: "<html><body>live-widget</body></html>",
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [],
            baseUriDomains: [],
          },
          permissions: {},
          permissive: true,
          mimeTypeValid: true,
          prefersBorder: true,
        }),
      status: 200,
      headers: new Headers(),
    } as Response);
  });

  type DisplayModeName = "inline" | "fullscreen" | "pip";
  type ControlledState = {
    displayMode: DisplayModeName;
    pipWidgetId: string | null;
    fullscreenWidgetId: string | null;
  };

  const controlledState: { current: ControlledState | null } = {
    current: null,
  };

  /**
   * Mirrors Thread's controlled display-mode wiring: the parent owns the
   * mode plus the fullscreen / PIP ownership ids, and clears an id only
   * when the widget that claimed it asks to exit.
   */
  function ControlledHost() {
    const [displayMode, setDisplayMode] =
      React.useState<DisplayModeName>("inline");
    const [pipWidgetId, setPipWidgetId] = React.useState<string | null>(null);
    const [fullscreenWidgetId, setFullscreenWidgetId] = React.useState<
      string | null
    >(null);
    controlledState.current = { displayMode, pipWidgetId, fullscreenWidgetId };
    const clearIfOwned = (id: string) => (current: string | null) =>
      current !== null && current === id ? null : current;
    // Stands in for ToolPart's display-mode picker (the user-initiated
    // path), which isn't mounted alongside a bare renderer. Same call
    // order as `ToolPart.handleDisplayModeChange`.
    const pickMode = (mode: DisplayModeName) => {
      if (displayMode === "fullscreen" && mode !== "fullscreen") {
        setFullscreenWidgetId(clearIfOwned(fullscreenWidgetId ?? "call-1"));
      } else if (displayMode === "pip" && mode !== "pip") {
        setPipWidgetId(clearIfOwned(pipWidgetId ?? "call-1"));
      }
      if (mode === "fullscreen") setFullscreenWidgetId("call-1");
      else if (mode === "pip") setPipWidgetId("call-1");
      setDisplayMode(mode);
    };
    return (
      <>
        <button type="button" onClick={() => pickMode("pip")}>
          host-picker-pip
        </button>
        <button type="button" onClick={() => pickMode("fullscreen")}>
          host-picker-fullscreen
        </button>
        <HostedRenderer
          {...baseProps}
          displayMode={displayMode}
          onDisplayModeChange={(mode: DisplayModeName) => setDisplayMode(mode)}
          pipWidgetId={pipWidgetId}
          fullscreenWidgetId={fullscreenWidgetId}
          onRequestPip={(id: string) => setPipWidgetId(id)}
          onExitPip={(id: string) => setPipWidgetId(clearIfOwned(id))}
          onRequestFullscreen={(id: string) => setFullscreenWidgetId(id)}
          onExitFullscreen={(id: string) =>
            setFullscreenWidgetId(clearIfOwned(id))
          }
        />
      </>
    );
  }

  const profileWith = (
    policy: "accept" | "user-initiated-only" | "decline",
  ): HostConfigMcpProfileV1 => ({
    profileVersion: 1,
    apps: { mcpAppsOverrides: { widgetDisplayModeRequests: policy } },
  });

  async function mountControlled(
    policy: "accept" | "user-initiated-only" | "decline",
  ) {
    render(
      <ActiveMcpProfileProvider value={profileWith(policy)}>
        <ScenarioHostStyleProvider value="mcpjam">
          <ControlledHost />
        </ScenarioHostStyleProvider>
      </ActiveMcpProfileProvider>,
    );
    await vi.waitFor(() => {
      expect(mockBridge.onrequestdisplaymode).not.toBeNull();
    });
    // Deliver the app's declared display modes.
    await act(async () => {
      mockBridge.oninitialized?.();
    });

    /** Drive a widget-initiated `ui/request-display-mode`. */
    const requestMode = async (mode: DisplayModeName) => {
      let granted: { mode: string } | undefined;
      await act(async () => {
        granted = await (
          mockBridge.onrequestdisplaymode as unknown as (args: {
            mode: DisplayModeName;
          }) => Promise<{ mode: string }>
        )({ mode });
      });
      return granted?.mode;
    };

    /** Click the host's own close chrome — the sticky-flag trigger. */
    const clickHostClose = async (label: string) => {
      await act(async () => {
        fireEvent.click(screen.getByLabelText(label));
      });
    };

    const publishedDisplayMode = () =>
      (
        mockBridge.setHostContext.mock.calls.at(-1)?.[0] as
          | { displayMode?: string }
          | undefined
      )?.displayMode;

    return { requestMode, clickHostClose, publishedDisplayMode };
  }

  it("accept: honors a fullscreen request after the user closes PIP", async () => {
    const { requestMode, clickHostClose, publishedDisplayMode } =
      await mountControlled("accept");

    expect(await requestMode("pip")).toBe("pip");
    expect(controlledState.current?.pipWidgetId).toBe("call-1");

    await clickHostClose("Close PiP mode");
    expect(controlledState.current?.displayMode).toBe("inline");

    // The regression: this returned "inline" and stranded the widget.
    expect(await requestMode("fullscreen")).toBe("fullscreen");
    expect(controlledState.current?.displayMode).toBe("fullscreen");
    expect(controlledState.current?.fullscreenWidgetId).toBe("call-1");
    expect(controlledState.current?.pipWidgetId).toBeNull();
    expect(publishedDisplayMode()).toBe("fullscreen");
  });

  it("accept: honors a PIP request after the user closes fullscreen", async () => {
    const { requestMode, clickHostClose, publishedDisplayMode } =
      await mountControlled("accept");

    expect(await requestMode("fullscreen")).toBe("fullscreen");
    expect(controlledState.current?.fullscreenWidgetId).toBe("call-1");

    await clickHostClose("Exit fullscreen");
    expect(controlledState.current?.displayMode).toBe("inline");

    expect(await requestMode("pip")).toBe("pip");
    expect(controlledState.current?.displayMode).toBe("pip");
    expect(controlledState.current?.pipWidgetId).toBe("call-1");
    expect(controlledState.current?.fullscreenWidgetId).toBeNull();
    expect(publishedDisplayMode()).toBe("pip");
  });

  it("accept: keeps honoring requests across repeated user closes", async () => {
    const { requestMode, clickHostClose } = await mountControlled("accept");

    expect(await requestMode("pip")).toBe("pip");
    await clickHostClose("Close PiP mode");
    expect(await requestMode("fullscreen")).toBe("fullscreen");
    await clickHostClose("Exit fullscreen");
    // A second dismissal must not mute the widget either.
    expect(await requestMode("pip")).toBe("pip");
  });

  it("accept: honors a widget round-trip through its own inline request", async () => {
    const { requestMode } = await mountControlled("accept");

    expect(await requestMode("pip")).toBe("pip");
    expect(await requestMode("inline")).toBe("inline");
    expect(await requestMode("fullscreen")).toBe("fullscreen");
    expect(controlledState.current?.fullscreenWidgetId).toBe("call-1");
  });

  it("user-initiated-only: keeps declining after the user closes PIP", async () => {
    const { requestMode, clickHostClose, publishedDisplayMode } =
      await mountControlled("user-initiated-only");

    // The mount seed seeds the sticky flag, so the widget can't open PIP
    // itself — the user does it from the host picker, which clears it.
    expect(await requestMode("pip")).toBe("inline");

    await act(async () => {
      fireEvent.click(screen.getByText("host-picker-pip"));
    });
    await vi.waitFor(() => {
      expect(controlledState.current?.displayMode).toBe("pip");
    });

    await clickHostClose("Close PiP mode");

    // Sticky protection is this policy's whole point: still declined.
    expect(await requestMode("fullscreen")).toBe("inline");
    expect(controlledState.current?.displayMode).toBe("inline");
    expect(controlledState.current?.fullscreenWidgetId).toBeNull();
    expect(publishedDisplayMode()).toBe("inline");
  });

  it("decline: refuses widget requests with or without a prior close", async () => {
    const { requestMode, clickHostClose } = await mountControlled("decline");

    expect(await requestMode("pip")).toBe("inline");
    expect(await requestMode("fullscreen")).toBe("inline");

    // Reach a non-inline mode via the host picker, then dismiss it — the
    // policy still refuses, and reports the mode the widget is actually in.
    await act(async () => {
      fireEvent.click(screen.getByText("host-picker-fullscreen"));
    });
    await vi.waitFor(() => {
      expect(controlledState.current?.displayMode).toBe("fullscreen");
    });
    expect(await requestMode("pip")).toBe("fullscreen");

    await clickHostClose("Exit fullscreen");
    expect(await requestMode("fullscreen")).toBe("inline");
  });

  // A request for a mode outside the advertised host ∩ app set is refused.
  // It used to be rewritten to `availableDisplayModes[0]` ("inline" in every
  // preset), so an unavailable-mode request became a forced mode change that
  // evicted the widget from the mode it already held.
  it("holds the current mode when the app asks for an unadvertised mode", async () => {
    // The app declares no fullscreen, so the advertised intersection can't
    // include it — but the widget asks for fullscreen anyway.
    mockBridge.getAppCapabilities.mockReturnValue({
      availableDisplayModes: ["inline", "pip"],
    });
    const { requestMode, publishedDisplayMode } = await mountControlled(
      "accept",
    );

    expect(await requestMode("pip")).toBe("pip");
    expect(controlledState.current?.pipWidgetId).toBe("call-1");

    // Refused — and the widget stays in PIP rather than dropping to inline.
    expect(await requestMode("fullscreen")).toBe("pip");
    expect(controlledState.current?.displayMode).toBe("pip");
    expect(controlledState.current?.pipWidgetId).toBe("call-1");
    expect(controlledState.current?.fullscreenWidgetId).toBeNull();
    expect(publishedDisplayMode()).toBe("pip");
  });

  it("reports inline when an unadvertised mode is requested from inline", async () => {
    mockBridge.getAppCapabilities.mockReturnValue({
      availableDisplayModes: ["inline", "pip"],
    });
    const { requestMode } = await mountControlled("accept");

    expect(await requestMode("fullscreen")).toBe("inline");
    expect(controlledState.current?.displayMode).toBe("inline");
    expect(controlledState.current?.fullscreenWidgetId).toBeNull();
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
    requestTeardown: boolean,
  ): HostConfigMcpProfileV1 => ({
    profileVersion: 1,
    apps: { mcpAppsOverrides: { requestTeardown } },
  });

  it("runs resource teardown and notifies the parent when enabled", async () => {
    const onRequestTeardown = vi.fn();
    render(
      <ActiveMcpProfileProvider value={profileWithRequestTeardown(true)}>
        <ScenarioHostStyleProvider value="claude">
          <HostedRenderer
            {...baseProps}
            onRequestTeardown={onRequestTeardown}
          />
        </ScenarioHostStyleProvider>
      </ActiveMcpProfileProvider>,
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
          <ScenarioHostStyleProvider value="claude">
            <HostedRenderer
              {...baseProps}
              onRequestTeardown={onRequestTeardown}
            />
            <HostedSurfaceHost />
          </ScenarioHostStyleProvider>
        </ActiveMcpProfileProvider>
      </WidgetSurfaceHostProvider>,
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
        <ScenarioHostStyleProvider value="claude">
          <HostedRenderer {...baseProps} />
        </ScenarioHostStyleProvider>
      </ActiveMcpProfileProvider>,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(mockBridge.onrequestteardown).toBeNull();
  });
});
