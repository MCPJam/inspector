import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DisplayContextHeader } from "../DisplayContextHeader";

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
  Settings2: () => <span data-testid="icon-settings" />,
  Palette: () => <span data-testid="icon-palette" />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, className, ...props }: any) => (
    <button onClick={onClick} className={className} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));

vi.mock("@/components/ui-playground/SafeAreaEditor", () => ({
  SafeAreaEditor: () => <div data-testid="safe-area-editor" />,
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  UIType: {
    OPENAI_SDK: "openai-apps",
    MCP_APPS: "mcp-apps",
    OPENAI_SDK_AND_MCP_APPS: "both",
  },
}));

const {
  mockUpdateThemeMode,
  mockPreferencesState,
  mockUIPlaygroundStore,
  mockPatchHostContext,
} = vi.hoisted(() => ({
  mockUpdateThemeMode: vi.fn(),
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
  mockPatchHostContext: vi.fn(),
}));

vi.mock("@/lib/theme-utils", () => ({
  updateThemeMode: mockUpdateThemeMode,
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) =>
    selector ? selector(mockPreferencesState) : mockPreferencesState,
}));

vi.mock("@/stores/ui-playground-store", () => ({
  useUIPlaygroundStore: (selector: any) =>
    selector ? selector(mockUIPlaygroundStore) : mockUIPlaygroundStore,
  DEVICE_VIEWPORT_CONFIGS: {
    mobile: { width: 375, height: 667 },
    tablet: { width: 768, height: 1024 },
    desktop: { width: 1280, height: 800 },
  },
}));

vi.mock("@/stores/widget-debug-store", () => ({
  useWidgetDebugStore: (selector: any) =>
    selector
      ? selector({ widgets: new Map() })
      : {
          widgets: new Map(),
        },
}));

vi.mock("@/stores/client-config-store", () => ({
  useClientConfigStore: (selector: any) =>
    selector
      ? selector({
          draftConfig: {
            hostContext: {
              locale: "en-US",
              timeZone: "UTC",
              displayMode: "inline",
            },
          },
          patchHostContext: mockPatchHostContext,
        })
      : {
          draftConfig: {
            hostContext: {
              locale: "en-US",
              timeZone: "UTC",
              displayMode: "inline",
            },
          },
          patchHostContext: mockPatchHostContext,
        },
}));

vi.mock("@/lib/client-config", () => ({
  clampDisplayModeToAvailableModes: vi
    .fn()
    .mockImplementation((displayMode) => displayMode),
  extractEffectiveHostDisplayMode: vi.fn().mockReturnValue("inline"),
  extractHostDeviceCapabilities: vi.fn().mockReturnValue({
    hover: true,
    touch: false,
  }),
  extractHostDisplayModes: vi
    .fn()
    .mockReturnValue(["inline", "pip", "fullscreen"]),
  extractHostLocale: vi.fn().mockReturnValue("en-US"),
  extractHostTimeZone: vi.fn().mockReturnValue("UTC"),
}));

describe("DisplayContextHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreferencesState.themeMode = "light";
    mockPreferencesState.hostStyle = "claude";
  });

  it("uses the local theme override without writing global theme state", () => {
    const onThemeToggleOverride = vi.fn();

    render(
      <DisplayContextHeader
        protocol={null}
        showThemeToggle
        themeModeOverride="dark"
        onThemeToggleOverride={onThemeToggleOverride}
      />,
    );

    expect(screen.getByTestId("icon-sun")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("display-context-theme-toggle"));

    expect(onThemeToggleOverride).toHaveBeenCalledTimes(1);
    expect(mockPreferencesState.setThemeMode).not.toHaveBeenCalled();
    expect(mockUpdateThemeMode).not.toHaveBeenCalled();
  });

  it("falls back to the global theme toggle when no override props are passed", () => {
    render(<DisplayContextHeader protocol={null} showThemeToggle />);

    expect(screen.getByTestId("icon-moon")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("display-context-theme-toggle"));

    expect(mockPreferencesState.setThemeMode).toHaveBeenCalledWith("dark");
    expect(mockUpdateThemeMode).toHaveBeenCalledWith("dark");
  });

  it("writes Claude and ChatGPT host-style selections through shared preferences", () => {
    render(<DisplayContextHeader protocol={null} />);

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
});
