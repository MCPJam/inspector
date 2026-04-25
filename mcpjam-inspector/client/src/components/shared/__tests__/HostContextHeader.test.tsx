import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HostContextHeader } from "../HostContextHeader";

const {
  mockPreferencesState,
  mockUIPlaygroundStore,
  mockHostContextState,
  mockPatchHostContext,
} = vi.hoisted(() => ({
  mockPreferencesState: {
    themeMode: "light",
    hostStyle: "claude",
    setThemeMode: vi.fn(),
    setHostStyle: vi.fn(),
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
  MousePointer2: () => <span data-testid="icon-mouse" />,
  Hand: () => <span data-testid="icon-hand" />,
  Palette: () => <span data-testid="icon-palette" />,
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

vi.mock("@/components/shared/HostContextDialog", () => ({
  HostContextDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="host-context-dialog" /> : null,
}));

vi.mock("@/components/shared/host-context-constants", () => ({
  PRESET_DEVICE_CONFIGS: {
    mobile: { width: 375, height: 667, label: "Phone", icon: () => null },
    tablet: { width: 768, height: 1024, label: "Tablet", icon: () => null },
    desktop: { width: 1280, height: 800, label: "Desktop", icon: () => null },
  },
  TIMEZONE_OPTIONS: [{ zone: "UTC", label: "UTC" }],
}));

vi.mock("@/components/shared/host-context-picker-bodies", () => ({
  CspPickerBody: () => <div />,
  DevicePickerBody: () => <div />,
  LocalePickerBody: () => <div />,
  TimezonePickerBody: () => <div />,
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) =>
    selector ? selector(mockPreferencesState) : mockPreferencesState,
}));

vi.mock("@/stores/ui-playground-store", () => ({
  useUIPlaygroundStore: (selector: any) =>
    selector ? selector(mockUIPlaygroundStore) : mockUIPlaygroundStore,
}));

vi.mock("@/stores/widget-debug-store", () => ({
  useWidgetDebugStore: (selector: any) =>
    selector
      ? selector({ widgets: new Map() })
      : {
          widgets: new Map(),
        },
}));

vi.mock("@/stores/host-context-store", () => ({
  useHostContextStore: (selector: any) =>
    selector
      ? selector({
          draftHostContext: mockHostContextState.draftHostContext,
          patchHostContext: mockPatchHostContext,
          isDirty: mockHostContextState.isDirty,
        })
      : {
          draftHostContext: mockHostContextState.draftHostContext,
          patchHostContext: mockPatchHostContext,
          isDirty: mockHostContextState.isDirty,
        },
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  UIType: {
    OPENAI_SDK: "openai-apps",
    MCP_APPS: "mcp-apps",
    OPENAI_SDK_AND_MCP_APPS: "both",
  },
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

describe("HostContextHeader", () => {
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
      <HostContextHeader
        activeWorkspaceId="workspace-1"
        protocol={null}
        showThemeToggle
      />,
    );

    expect(screen.getByTestId("icon-sun")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("host-context-theme-toggle"));

    expect(mockPatchHostContext).toHaveBeenCalledWith({ theme: "light" });
    expect(mockPreferencesState.setThemeMode).not.toHaveBeenCalled();
  });

  it("writes Claude and ChatGPT host-style selections through shared preferences", () => {
    render(
      <HostContextHeader activeWorkspaceId="workspace-1" protocol={null} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "ChatGPT" }));

    expect(mockPreferencesState.setHostStyle).toHaveBeenNthCalledWith(
      1,
      "claude",
    );
    expect(mockPreferencesState.setHostStyle).toHaveBeenNthCalledWith(
      2,
      "chatgpt",
    );
  });

  it("surfaces unsaved state and opens the raw host context dialog", () => {
    mockHostContextState.isDirty = true;

    render(
      <HostContextHeader activeWorkspaceId="workspace-1" protocol={null} />,
    );

    expect(screen.getByTestId("host-context-trigger")).toHaveTextContent(
      "Unsaved",
    );

    fireEvent.click(screen.getByTestId("host-context-trigger"));

    expect(screen.getByTestId("host-context-dialog")).toBeInTheDocument();
  });
});
