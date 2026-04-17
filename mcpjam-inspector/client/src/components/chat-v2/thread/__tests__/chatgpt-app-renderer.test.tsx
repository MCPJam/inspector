import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const stableTrafficLogFns = {
  addLog: vi.fn(),
};

const stableWidgetDebugFns = {
  setWidgetDebugInfo: vi.fn(),
  setWidgetState: vi.fn(),
  setWidgetGlobals: vi.fn(),
  addCspViolation: vi.fn(),
  setWidgetCsp: vi.fn(),
  setWidgetHtml: vi.fn(),
  clearCspViolations: vi.fn(),
};

const mockPlaygroundStoreState = {
  isPlaygroundActive: false,
  cspMode: "permissive" as const,
  deviceType: "desktop" as const,
  capabilities: { hover: true, touch: false },
  safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  globals: { locale: "en-US", timeZone: "UTC" },
};

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: string }) => unknown) =>
    selector({ themeMode: "light" }),
}));

vi.mock("@/stores/ui-playground-store", () => ({
  useUIPlaygroundStore: (selector: (state: typeof mockPlaygroundStoreState) => unknown) =>
    selector(mockPlaygroundStoreState),
}));

vi.mock("@/stores/client-config-store", () => ({
  useClientConfigStore: (
    selector: (state: { draftConfig?: { hostContext?: Record<string, unknown> } }) => unknown,
  ) => selector({ draftConfig: undefined }),
}));

vi.mock("@/stores/traffic-log-store", () => ({
  useTrafficLogStore: (selector: (state: typeof stableTrafficLogFns) => unknown) =>
    selector(stableTrafficLogFns),
  extractMethod: vi.fn(),
}));

vi.mock("@/stores/widget-debug-store", () => ({
  useWidgetDebugStore: (
    selector: (state: typeof stableWidgetDebugFns) => unknown,
  ) => selector(stableWidgetDebugFns),
}));

vi.mock("sonner", () => ({
  toast: {
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../checkout-dialog", () => ({
  CheckoutDialog: () => null,
}));

vi.mock("@mcpjam/design-system/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/chatgpt-sandboxed-iframe", () => ({
  ChatGPTSandboxedIframe: React.forwardRef((props: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      postMessage: vi.fn(),
      setHeight: vi.fn(),
      setWidth: vi.fn(),
    }));
    return (
      <div
        data-testid="chatgpt-sandboxed-iframe"
        className={props.className}
        style={props.style}
      />
    );
  }),
}));

import { ChatGPTAppRenderer } from "../chatgpt-app-renderer";

describe("ChatGPTAppRenderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: false,
      cspMode: "permissive",
      deviceType: "desktop",
      capabilities: { hover: true, touch: false },
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      globals: { locale: "en-US", timeZone: "UTC" },
    });
  });

  it("anchors desktop playground PiP to the playground shell", async () => {
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: true,
      deviceType: "desktop",
    });

    render(
      <ChatGPTAppRenderer
        serverId="server-1"
        toolCallId="call-1"
        toolName="test-tool"
        toolState="output-available"
        toolMetadata={{ "openai/outputTemplate": "ui://widget.html" }}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="pip"
        pipWidgetId="call-1"
      />,
    );

    const iframe = await screen.findByTestId("chatgpt-sandboxed-iframe");
    const container = iframe.parentElement as HTMLElement | null;
    expect(container).not.toBeNull();
    expect(container?.className).toContain("absolute");
    expect(container?.className).not.toContain("fixed");
    expect(container?.className).toContain("top-4");
  });

  it("keeps desktop playground fullscreen as a fixed breakout overlay", async () => {
    Object.assign(mockPlaygroundStoreState, {
      isPlaygroundActive: true,
      deviceType: "desktop",
    });

    render(
      <ChatGPTAppRenderer
        serverId="server-1"
        toolCallId="call-1"
        toolName="test-tool"
        toolState="output-available"
        toolMetadata={{ "openai/outputTemplate": "ui://widget.html" }}
        cachedWidgetHtmlUrl="blob:cached"
        displayMode="fullscreen"
        fullscreenWidgetId="call-1"
      />,
    );

    const iframe = await screen.findByTestId("chatgpt-sandboxed-iframe");
    const container = iframe.parentElement as HTMLElement | null;
    expect(container).not.toBeNull();
    expect(container?.className).toContain("fixed");
    expect(container?.className).toContain("inset-0");
  });
});
