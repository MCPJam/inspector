import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * A connected server's own icon brands its tool calls, the way the end client
 * shows it. `/mcp.svg` stays the fallback for servers that declare none. A
 * server shipping one icon per theme gets the one matching the chat. BB-136.
 *
 * Mock stack mirrors tool-part-run-location.test.tsx.
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

vi.mock("@/hooks/useComputersEnabled", () => ({
  useLocalComputerEnabled: () => false,
}));

vi.mock("../../thread-helpers", () => ({
  getToolNameFromType: () => "search_docs",
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
import { AppStateProvider } from "@/state/app-state-context";
import { ScenarioHostThemeProvider } from "@/contexts/scenario-client-style-context";

const part = {
  type: "tool-invocation" as const,
  toolName: "search_docs",
  toolCallId: "call-1",
  state: "output-available",
  input: { query: "mcp" },
  output: { ok: true },
};

function tree(icons: unknown, theme: "light" | "dark") {
  const appState = {
    servers: { docs: { initializationInfo: { serverVersion: { icons } } } },
  } as any;
  return (
    <AppStateProvider appState={appState}>
      <ScenarioHostThemeProvider value={theme}>
        <ToolPart part={part as any} uiType="mcp-apps" serverId="docs" />
      </ScenarioHostThemeProvider>
    </AppStateProvider>
  );
}

function renderWithServerIcons(
  icons: unknown,
  theme: "light" | "dark" = "light",
) {
  return render(tree(icons, theme));
}

const iconSrc = () =>
  screen.getByTestId("tool-server-icon").getAttribute("src");

describe("ToolPart server icon", () => {
  it("brands the tool call with the server's own icon", () => {
    renderWithServerIcons([{ src: "https://docs.example/logo.png" }]);
    expect(iconSrc()).toBe("https://docs.example/logo.png");
  });

  it("uses the icon the server declared for the theme in view", () => {
    renderWithServerIcons(
      [
        { src: "https://srv.test/light.png", theme: "light" },
        { src: "https://srv.test/dark.png", theme: "dark" },
      ],
      "dark",
    );
    expect(iconSrc()).toBe("https://srv.test/dark.png");
  });

  it("keeps the MCP mark for a server that declares no icon", () => {
    renderWithServerIcons(undefined);
    expect(iconSrc()).toBe("/mcp.svg");
  });

  it("falls back to the MCP mark when the server's icon fails to load", () => {
    renderWithServerIcons([{ src: "https://docs.example/gone.png" }]);
    fireEvent.error(screen.getByTestId("tool-server-icon"));
    expect(iconSrc()).toBe("/mcp.svg");
  });
  it("retries when the src changes after a failure", () => {
    // The failure belongs to the URL, not to the card. Latching it on a
    // boolean stranded the header on /mcp.svg: flip the theme after the dark
    // icon 404s and the perfectly good light one never gets drawn.
    const icons = [
      { src: "https://srv.test/light.png", theme: "light" },
      { src: "https://srv.test/dark.png", theme: "dark" },
    ];
    const { rerender } = renderWithServerIcons(icons, "dark");
    fireEvent.error(screen.getByTestId("tool-server-icon"));
    expect(iconSrc()).toBe("/mcp.svg");

    rerender(tree(icons, "light"));
    expect(iconSrc()).toBe("https://srv.test/light.png");
  });
});
