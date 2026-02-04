import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolPart } from "../tool-part";

// Mock lucide-react icons
vi.mock("lucide-react", () => {
  const s = (props: any) => <div {...props} />;
  return {
    AlignLeft: s,
    AlertCircle: s,
    Box: s,
    Check: s,
    ChevronDown: s,
    ChevronRight: s,
    Copy: s,
    Database: s,
    ExternalLink: s,
    Eye: s,
    Lightbulb: s,
    Maximize2: s,
    MessageCircle: s,
    Minimize2: s,
    Pencil: s,
    PictureInPicture2: s,
    Redo2: s,
    Shield: s,
    Undo2: s,
  };
});

// Mock stores
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => "light",
}));

vi.mock("@/stores/widget-debug-store", () => ({
  useWidgetDebugStore: (selector: any) =>
    // Return a truthy value so hasWidgetDebug=true and display mode controls show
    selector({
      widgets: new Map([
        ["call-1", { globals: {}, logs: [], cspViolations: [] }],
      ]),
    }),
}));

// Mock thread-helpers
vi.mock("../../thread-helpers", () => ({
  getToolNameFromType: () => "test-tool",
  getToolStateMeta: () => ({
    Icon: (props: any) => <div data-testid="status-icon" {...props} />,
    className: "",
  }),
  safeStringify: (v: any) => JSON.stringify(v),
  isDynamicTool: () => false,
}));

// Mock UIType
vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  UIType: { MCP_APPS: "mcp-apps", OPENAI_SDK: "openai-apps" },
}));

// Mock tooltip components to render children directly
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock("../../csp-debug-panel", () => ({
  CspDebugPanel: () => null,
}));

// Mock JsonEditor to avoid pulling in additional lucide icons
vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({ value }: any) => (
    <pre data-testid="json-editor">{JSON.stringify(value)}</pre>
  ),
}));

const basePart = {
  type: "tool-invocation" as const,
  toolName: "test-tool",
  toolCallId: "call-1",
  state: "output-available",
  input: {},
  output: {},
};

describe("ToolPart display mode controls", () => {
  let onDisplayModeChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onDisplayModeChange = vi.fn();
  });

  const renderWithDisplayModes = (
    appSupportedDisplayModes?: ("inline" | "pip" | "fullscreen")[],
  ) =>
    render(
      <ToolPart
        part={basePart as any}
        uiType="mcp-apps"
        displayMode="inline"
        onDisplayModeChange={onDisplayModeChange}
        appSupportedDisplayModes={appSupportedDisplayModes}
      />,
    );

  it("shows all display mode buttons enabled when appSupportedDisplayModes is undefined", () => {
    renderWithDisplayModes(undefined);

    const buttons = screen.getAllByRole("button");
    const displayButtons = buttons.filter(
      (b) => !b.hasAttribute("disabled") || b.getAttribute("disabled") === "",
    );
    // All 3 display mode buttons should be present and none disabled
    const disabledButtons = buttons.filter(
      (b) => b.getAttribute("disabled") !== null,
    );
    expect(disabledButtons).toHaveLength(0);
  });

  it("disables pip and fullscreen when app only supports inline", async () => {
    renderWithDisplayModes(["inline"]);
    const user = userEvent.setup();

    const buttons = screen.getAllByRole("button");
    // Find disabled buttons (pip and fullscreen)
    const disabledButtons = buttons.filter((b) => b.disabled);
    expect(disabledButtons).toHaveLength(2);

    // Click disabled buttons — onDisplayModeChange should NOT be called
    for (const btn of disabledButtons) {
      await user.click(btn);
    }
    expect(onDisplayModeChange).not.toHaveBeenCalled();
  });

  it("disables only fullscreen when app supports inline and pip", async () => {
    renderWithDisplayModes(["inline", "pip"]);
    const user = userEvent.setup();

    const buttons = screen.getAllByRole("button");
    const disabledButtons = buttons.filter((b) => b.disabled);
    expect(disabledButtons).toHaveLength(1);

    await user.click(disabledButtons[0]);
    expect(onDisplayModeChange).not.toHaveBeenCalled();
  });

  it("enables all buttons when app supports all three modes", () => {
    renderWithDisplayModes(["inline", "pip", "fullscreen"]);

    const buttons = screen.getAllByRole("button");
    const disabledButtons = buttons.filter((b) => b.disabled);
    expect(disabledButtons).toHaveLength(0);
  });

  it("allows clicking enabled display mode buttons", async () => {
    renderWithDisplayModes(["inline", "pip"]);
    const user = userEvent.setup();

    const buttons = screen.getAllByRole("button");
    const enabledButtons = buttons.filter((b) => !b.disabled);
    // Click first enabled display mode button (the header toggle is also a button, so find the right ones)
    // The inline button should be enabled and clickable
    for (const btn of enabledButtons) {
      await user.click(btn);
    }
    // At least one call for the pip button
    expect(onDisplayModeChange).toHaveBeenCalled();
  });

  it("shows 'not supported' in tooltip for disabled modes", () => {
    renderWithDisplayModes(["inline"]);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const unsupportedTooltips = tooltips.filter((t) =>
      t.textContent?.includes("not supported by this app"),
    );
    expect(unsupportedTooltips).toHaveLength(2);
  });
});
