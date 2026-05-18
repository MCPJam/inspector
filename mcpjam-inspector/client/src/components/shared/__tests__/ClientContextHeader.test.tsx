import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClientContextHeader } from "../ClientContextHeader";

const {
  mockPreferencesState,
  mockUIPlaygroundStore,
  mockHostContextState,
  mockPatchHostContext,
  mockApplyHostTemplate,
  mockApplyHostDefaultsToPlayground,
} = vi.hoisted(() => ({
  mockPreferencesState: {
    themeMode: "light",
    hostStyle: "claude",
    hostCapabilitiesOverride: undefined,
    setThemeMode: vi.fn(),
    setHostStyle: vi.fn(),
    setHostCapabilitiesOverride: vi.fn(),
    setChatUiOverride: vi.fn(),
  },
  mockUIPlaygroundStore: {
    deviceType: "desktop",
    setDeviceType: vi.fn(),
    customViewport: { width: 1280, height: 800 },
    setCustomViewport: vi.fn(),
    cspMode: "widget-declared",
    setCspMode: vi.fn(),
    mcpAppsCspMode: "widget-declared",
    setMcpAppsCspMode: vi.fn(),
  },
  mockHostContextState: {
    draftHostContext: {
      locale: "en-US",
      timeZone: "UTC",
      theme: "dark",
      displayMode: "inline",
      availableDisplayModes: ["inline", "pip", "fullscreen"],
      deviceCapabilities: {
        hover: true,
        touch: false,
      },
    } as Record<string, unknown>,
    patchHostContext: vi.fn(),
    isDirty: false,
  },
  mockPatchHostContext: vi.fn(),
  mockApplyHostTemplate: vi.fn(),
  mockApplyHostDefaultsToPlayground: vi.fn(),
}));

vi.mock("lucide-react", () => ({
  Smartphone: () => <span data-testid="icon-smartphone" />,
  Tablet: () => <span data-testid="icon-tablet" />,
  Monitor: () => <span data-testid="icon-monitor" />,
  Sun: () => <span data-testid="icon-sun" />,
  Moon: () => <span data-testid="icon-moon" />,
  Globe: () => <span data-testid="icon-globe" />,
  Clock: () => <span data-testid="icon-clock" />,
  Shield: () => <span data-testid="icon-shield" />,
  Cpu: () => <span data-testid="icon-cpu" />,
  Settings2: () => <span data-testid="icon-settings" />,
  MousePointer2: () => <span data-testid="icon-mouse" />,
  Hand: () => <span data-testid="icon-hand" />,
}));

vi.mock("@mcpjam/design-system/button", () => ({
  Button: ({ children, onClick, className, ...props }: any) => (
    <button onClick={onClick} className={className} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@mcpjam/design-system/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@mcpjam/design-system/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/ui-playground/SafeAreaEditor", () => ({
  SafeAreaEditor: () => <div data-testid="safe-area-editor" />,
}));

vi.mock("@/components/shared/ClientContextDialog", () => ({
  ClientContextDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="host-context-dialog" /> : null,
}));

vi.mock("@/components/client-config/ClientCapabilitiesOverrideDialog", () => ({
  ClientCapabilitiesOverrideDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="host-capabilities-dialog" /> : null,
}));

vi.mock("@/components/shared/client-context-constants", () => ({
  PRESET_DEVICE_CONFIGS: {
    mobile: { width: 375, height: 667, label: "Phone", icon: () => null },
    tablet: { width: 768, height: 1024, label: "Tablet", icon: () => null },
    desktop: { width: 1280, height: 800, label: "Desktop", icon: () => null },
  },
  TIMEZONE_OPTIONS: [{ zone: "UTC", label: "UTC" }],
}));

vi.mock("@/components/shared/client-context-picker-bodies", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/components/shared/client-context-picker-bodies")
    >();
  return {
    ...actual,
    CspPickerBody: () => <div />,
    DevicePickerBody: () => <div />,
    LocalePickerBody: () => <div />,
    TimezonePickerBody: () => <div />,
  };
});

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) =>
    selector ? selector(mockPreferencesState) : mockPreferencesState,
}));

vi.mock("@/stores/ui-playground-store", () => {
  const useUIPlaygroundStore: any = (selector: any) =>
    selector ? selector(mockUIPlaygroundStore) : mockUIPlaygroundStore;
  // `applyHostDefaultsToPlayground` reads via `.getState()` — expose the
  // same shape as the hook selector consumers.
  useUIPlaygroundStore.getState = () => mockUIPlaygroundStore;
  return { useUIPlaygroundStore };
});

vi.mock("@/stores/widget-debug-store", () => ({
  useWidgetDebugStore: (selector: any) =>
    selector
      ? selector({ widgets: new Map() })
      : {
          widgets: new Map(),
        },
}));

vi.mock("@/stores/client-context-store", () => {
  const buildState = () => ({
    draftHostContext: mockHostContextState.draftHostContext,
    patchHostContext: mockPatchHostContext,
    applyHostTemplate: mockApplyHostTemplate,
    isDirty: mockHostContextState.isDirty,
  });
  const useHostContextStore: any = (selector: any) =>
    selector ? selector(buildState()) : buildState();
  // `applyHostDefaultsToPlayground` reads `applyHostTemplate` via
  // `.getState()`; expose the same shape.
  useHostContextStore.getState = buildState;
  return { useHostContextStore };
});

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  UIType: {
    OPENAI_SDK: "openai-apps",
    MCP_APPS: "mcp-apps",
    OPENAI_SDK_AND_MCP_APPS: "both",
  },
}));

// Stub the helper so the test verifies the wire (pill onClick → helper)
// without pulling in the helper's full dependency graph (host-templates →
// host-config-v2 → ...). The helper's behavior is covered by its own unit
// test at lib/playground/__tests__/apply-host-defaults.test.ts.
vi.mock("@/lib/playground/apply-client-defaults", () => ({
  applyHostDefaultsToPlayground: mockApplyHostDefaultsToPlayground,
}));

vi.mock("@/lib/client-config", () => ({
  extractEffectiveHostDisplayMode: (hostContext: Record<string, unknown>) =>
    hostContext.displayMode ?? "inline",
  extractHostDeviceCapabilities: (hostContext: Record<string, unknown>) =>
    hostContext.deviceCapabilities ?? {
      hover: true,
      touch: false,
    },
  extractHostDisplayModes: (hostContext: Record<string, unknown>) =>
    hostContext.availableDisplayModes ?? ["inline", "pip", "fullscreen"],
  extractHostLocale: (
    hostContext: Record<string, unknown>,
    fallback: string,
  ) => hostContext.locale ?? fallback,
  extractHostTheme: (hostContext: Record<string, unknown>) =>
    hostContext.theme,
  extractHostTimeZone: (
    hostContext: Record<string, unknown>,
    fallback: string,
  ) => hostContext.timeZone ?? fallback,
}));

describe("ClientContextHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreferencesState.themeMode = "light";
    mockPreferencesState.hostStyle = "claude";
    mockHostContextState.draftHostContext = {
      locale: "en-US",
      timeZone: "UTC",
      theme: "dark",
      displayMode: "inline",
      availableDisplayModes: ["inline", "pip", "fullscreen"],
      deviceCapabilities: {
        hover: true,
        touch: false,
      },
    };
    mockHostContextState.isDirty = false;
  });

  it("writes theme changes through hostContext instead of global preferences", () => {
    render(
      <ClientContextHeader
        activeProjectId="project-1"
        protocol={null}
        showThemeToggle
      />,
    );

    expect(screen.getByTestId("icon-sun")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("host-context-theme-toggle"));

    expect(mockPatchHostContext).toHaveBeenCalledWith({ theme: "light" });
    expect(mockPreferencesState.setThemeMode).not.toHaveBeenCalled();
  });

  it("invokes the playground snapshot helper for each pill click with the right host id", () => {
    render(
      <ClientContextHeader activeProjectId="project-1" protocol={null} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "ChatGPT" }));

    // setHostStyle is no longer called directly from the pill onClick —
    // the helper owns it (so a single seam writes the brand-pill id +
    // chip stores together). Assert via the helper instead.
    expect(mockPreferencesState.setHostStyle).not.toHaveBeenCalled();
    expect(mockApplyHostDefaultsToPlayground).toHaveBeenCalledTimes(2);
    expect(mockApplyHostDefaultsToPlayground.mock.calls[0]?.[0]).toBe(
      "claude",
    );
    expect(mockApplyHostDefaultsToPlayground.mock.calls[1]?.[0]).toBe(
      "chatgpt",
    );
  });

  it("calls the playground snapshot helper with both preferences setters in a bag", () => {
    render(
      <ClientContextHeader activeProjectId="project-1" protocol={null} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "ChatGPT" }));

    expect(mockApplyHostDefaultsToPlayground).toHaveBeenCalledTimes(1);
    expect(mockApplyHostDefaultsToPlayground.mock.calls[0]?.[0]).toBe(
      "chatgpt",
    );
    // Second arg is the setters bag — the preferences-store setters that
    // the helper writes through (preferences store is context-scoped, so
    // the helper can't `getState()` on it).
    expect(mockApplyHostDefaultsToPlayground.mock.calls[0]?.[1]).toEqual({
      setHostStyle: mockPreferencesState.setHostStyle,
      setHostCapabilitiesOverride:
        mockPreferencesState.setHostCapabilitiesOverride,
      setChatUiOverride: mockPreferencesState.setChatUiOverride,
    });
  });

  it("surfaces unsaved state and opens the raw host context dialog", () => {
    mockHostContextState.isDirty = true;

    render(
      <ClientContextHeader activeProjectId="project-1" protocol={null} />,
    );

    expect(screen.getByTestId("host-context-trigger")).toHaveTextContent(
      "Unsaved",
    );

    fireEvent.click(screen.getByTestId("host-context-trigger"));

    expect(screen.getByTestId("host-context-dialog")).toBeInTheDocument();
  });

  it("labels the host capabilities override control as Host Capabilities", () => {
    render(
      <ClientContextHeader activeProjectId="project-1" protocol={null} />,
    );

    expect(screen.getByTestId("host-capabilities-trigger")).toHaveTextContent(
      "Host Capabilities",
    );
  });

  it("does not render the display-mode badge in the toolbar", () => {
    render(
      <ClientContextHeader activeProjectId="project-1" protocol={null} />,
    );

    expect(screen.queryByText("Display")).not.toBeInTheDocument();
    expect(screen.queryByText("Inline")).not.toBeInTheDocument();
  });
});
