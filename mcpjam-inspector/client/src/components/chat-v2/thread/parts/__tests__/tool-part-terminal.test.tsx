import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScenarioHostStyleProvider } from "@/contexts/scenario-client-style-context";
import { PlaygroundTerminalPresentationProvider } from "@/contexts/playground-terminal-presentation";

/**
 * In a Playground terminal client the tool card swaps the MCP icon for the
 * client's tool glyph. Mock stack mirrors tool-part-harness-label.test.tsx.
 */

vi.mock("lucide-react", () => {
  const s = (props: any) => <div {...props} />;
  return {
    Box: s,
    Check: s,
    ChevronDown: s,
    Database: s,
    Loader2: s,
    Maximize2: s,
    MessageCircle: s,
    Pencil: s,
    PictureInPicture2: s,
    Play: s,
    RotateCcw: s,
    Shield: s,
    ShieldCheck: s,
    ShieldX: s,
    Terminal: s,
    X: s,
  };
});

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) => selector({ themeMode: "light" }),
}));

vi.mock("@/stores/widget-debug-store", () => ({
  useWidgetDebugStore: (selector: any) => selector({ widgets: new Map() }),
}));

const toolNameState = vi.hoisted(() => ({ name: "search_docs" }));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useLocalComputerEnabled: () => false,
}));
vi.mock("../../thread-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../thread-helpers")>()),
  getToolNameFromType: () => toolNameState.name,
  getToolStateMeta: () => ({
    Icon: (props: any) => <div data-testid="status-icon" {...props} />,
    className: "",
  }),
  safeStringify: (v: any) => JSON.stringify(v),
  isDynamicTool: () => false,
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  UIType: { MCP_APPS: "mcp-apps", OPENAI_SDK: "openai-apps" },
}));

vi.mock("@mcpjam/design-system/tooltip", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <span>{children}</span>,
}));

vi.mock("@mcpjam/design-system/badge", () => ({
  Badge: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock("../../sandbox-debug-panel", () => ({
  SandboxDebugPanel: () => null,
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({ value }: any) => (
    <pre data-testid="json-editor">{JSON.stringify(value)}</pre>
  ),
}));

vi.mock("../text-part", () => ({
  TextPart: ({ text }: { text: string }) => (
    <div data-testid="text-part">{text}</div>
  ),
}));

import { ToolPart } from "../tool-part";

const part = {
  type: "tool-invocation",
  toolCallId: "call-1",
  state: "output-available",
  input: { query: "pricing" },
  output: {},
} as any;

describe("ToolPart in a Playground terminal client", () => {
  it("shows the client's tool glyph instead of the MCP icon and expands on click", () => {
    const { container } = render(
      <ScenarioHostStyleProvider value="claude-code">
        <PlaygroundTerminalPresentationProvider value>
          <ToolPart part={part} serverId="srv" />
        </PlaygroundTerminalPresentationProvider>
      </ScenarioHostStyleProvider>,
    );
    expect(screen.getByText("└")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector('img[src="/mcp.svg"]')).toBeNull();
    const header = screen.getByText("search_docs").closest('[role="button"]');
    expect(header).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(header!);
    expect(header).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the MCP icon outside Playground", () => {
    const { container } = render(
      <ScenarioHostStyleProvider value="claude-code">
        <ToolPart part={part} serverId="srv" />
      </ScenarioHostStyleProvider>,
    );
    expect(container.querySelector('img[src="/mcp.svg"]')).not.toBeNull();
    expect(screen.queryByText("└")).toBeNull();
  });
});
