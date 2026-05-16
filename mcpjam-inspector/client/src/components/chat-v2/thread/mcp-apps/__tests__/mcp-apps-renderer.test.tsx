import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import React from "react";
import { CHATGPT_HOST_STYLE, CLAUDE_HOST_STYLE } from "@/lib/host-styles";

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
    mockAppBridgeCtor,
    mockPostMessageTransport: vi.fn(),
    mockSandboxPostMessage: vi.fn(),
    sandboxedIframePropsRef: { current: null as any },
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
  useUIPlaygroundStore: (selector: any) =>
    selector(mockPlaygroundStoreState),
}));

vi.mock("@/stores/host-context-store", () => ({
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

vi.mock("../mcp-apps-modal", () => ({
  McpAppsModal: () => null,
}));

// ── Import component under test (after mocks) ─────────────────────────────
import { MCPAppsRenderer } from "../mcp-apps-renderer";
import { authFetch } from "@/lib/session-token";
import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-host-style-context";
import { ChatboxHostCapabilitiesOverrideProvider } from "@/contexts/chatbox-host-capabilities-override-context";

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
    mockSandboxPostMessage.mockClear();
    sandboxedIframePropsRef.current = null;
    sandboxProxyBehaviorRef.current.autoReady = true;
    appBridgeArgsRef.current = null;

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
      <ChatboxHostStyleProvider value="claude">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    // Should advertise Claude's preset, not the old empty literal.
    expect(appBridgeArgsRef.current?.hostCapabilities).toEqual(
      expect.objectContaining(CLAUDE_HOST_STYLE.mcp.hostCapabilities),
    );
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
      </ChatboxHostStyleProvider>,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    expect(appBridgeArgsRef.current?.hostCapabilities).toEqual(
      expect.objectContaining(CHATGPT_HOST_STYLE.mcp.hostCapabilities),
    );
    // Sanity: profiles differ — switching is observable.
    expect(appBridgeArgsRef.current?.hostCapabilities).not.toEqual(
      expect.objectContaining(CLAUDE_HOST_STYLE.mcp.hostCapabilities),
    );
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
      </ChatboxHostCapabilitiesOverrideProvider>,
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
      </ChatboxHostStyleProvider>,
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
      <ChatboxHostStyleProvider value="claude">
        <ChatboxHostThemeProvider value="dark">
          <MCPAppsRenderer {...baseProps} />
        </ChatboxHostThemeProvider>
      </ChatboxHostStyleProvider>,
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
      <ChatboxHostStyleProvider value="claude">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>,
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
      <ChatboxHostStyleProvider value="claude">
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostStyleProvider>,
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
      <ChatboxHostStyleProvider value="claude">
        <MCPAppsRenderer {...baseProps} prefersBorder={false} />
      </ChatboxHostStyleProvider>,
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

    render(
      <MCPAppsRenderer
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
      <MCPAppsRenderer
        {...baseProps}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="fullscreen"
        fullscreenWidgetId="call-1"
      />,
    );

    const iframe = await screen.findByTestId("sandboxed-iframe");
    const container = iframe.parentElement as HTMLElement | null;
    expect(container).not.toBeNull();
    expect(container?.className).toContain("fixed");
    expect(container?.className).toContain("inset-0");
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
        }),
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
    render(<MCPAppsRenderer {...baseProps} />);

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

  it("waits for the bridge transport before loading widget HTML into the sandbox", async () => {
    let resolveConnect: (() => void) | undefined;
    mockBridge.connect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );

    render(
      <MCPAppsRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />,
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
        "<html><body>widget</body></html>",
      );
    });
  });

  it("waits for the sandbox proxy before starting the bridge handshake", async () => {
    sandboxProxyBehaviorRef.current.autoReady = false;

    render(
      <MCPAppsRenderer {...baseProps} cachedWidgetHtmlUrl="blob:cached" />,
    );

    await vi.waitFor(() => {
      expect(stableStoreFns.setWidgetHtml).toHaveBeenCalledWith(
        "call-1",
        "<html><body>widget</body></html>",
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

  it("refuses every gated handler when advertised capabilities is empty {}", async () => {
    render(
      <ChatboxHostCapabilitiesOverrideProvider value={{}}>
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostCapabilitiesOverrideProvider>,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    // tools/call → unsupported + sendToolCancelled fired
    await expect(
      mockBridge.oncalltool?.(
        { name: "tool", arguments: {} } as any,
        {} as any,
      ),
    ).rejects.toThrow(/serverTools/);
    expect(mockBridge.sendToolCancelled).toHaveBeenCalled();

    // ui/open-link
    await expect(
      mockBridge.onopenlink?.({ url: "https://example.com" } as any),
    ).rejects.toThrow(/openLinks/);

    // ui/message
    await expect(
      mockBridge.onmessage?.({
        content: [{ type: "text", text: "hi" }],
      } as any),
    ).rejects.toThrow(/message/);

    // ui/update-model-context
    await expect(
      mockBridge.onupdatemodelcontext?.({} as any),
    ).rejects.toThrow(/updateModelContext/);

    // resources/read + list + templates
    await expect(
      mockBridge.onreadresource?.({ uri: "ui://foo" } as any),
    ).rejects.toThrow(/serverResources/);
    await expect(
      mockBridge.onlistresources?.({} as any),
    ).rejects.toThrow(/serverResources/);
    await expect(
      mockBridge.onlistresourcetemplates?.({} as any),
    ).rejects.toThrow(/serverResources/);

    // logging — silently dropped, never surfaced as supported
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    act(() => {
      mockBridge.onloggingmessage?.({
        level: "info",
        data: { message: "hi" },
        logger: "widget",
      });
    });
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("allows only the single advertised capability", async () => {
    render(
      <ChatboxHostCapabilitiesOverrideProvider value={{ openLinks: {} }}>
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostCapabilitiesOverrideProvider>,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    // openLinks is allowed — opens window
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => null);
    await expect(
      mockBridge.onopenlink?.({ url: "https://example.com" } as any),
    ).resolves.toEqual({});
    expect(openSpy).toHaveBeenCalled();
    openSpy.mockRestore();

    // Everything else is still gated
    await expect(
      mockBridge.onmessage?.({
        content: [{ type: "text", text: "hi" }],
      } as any),
    ).rejects.toThrow(/message/);
  });

  it("rebuilds the bridge when hostCapabilitiesOverride flips", async () => {
    const { rerender } = render(
      <ChatboxHostCapabilitiesOverrideProvider value={{ openLinks: {} }}>
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostCapabilitiesOverrideProvider>,
    );

    await vi.waitFor(() => {
      expect(mockBridge.connect).toHaveBeenCalled();
    });
    const firstCalls = mockAppBridgeCtor.mock.calls.length;

    rerender(
      <ChatboxHostCapabilitiesOverrideProvider value={{ message: { text: {} } }}>
        <MCPAppsRenderer {...baseProps} />
      </ChatboxHostCapabilitiesOverrideProvider>,
    );

    await vi.waitFor(() => {
      expect(mockAppBridgeCtor.mock.calls.length).toBeGreaterThan(firstCalls);
    });

    // After rebuild the new bridge gates on the new contract: openLinks
    // is gone, message is allowed.
    await expect(
      mockBridge.onopenlink?.({ url: "https://example.com" } as any),
    ).rejects.toThrow(/openLinks/);
    await expect(
      mockBridge.onmessage?.({
        content: [{ type: "text", text: "hi" }],
      } as any),
    ).resolves.toEqual({});
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
