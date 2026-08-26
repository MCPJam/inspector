import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * The icon on a tool-call header. A connected server that declares `icons` in
 * its initialize response gets its own mark; anything else falls back to the
 * generic /mcp.svg.
 *
 * The dark-mode assertions are the point of the class split: /mcp.svg is
 * monochrome and needs `filter invert` to stay legible on a dark background,
 * but inverting a colour logo turns an orange server mark blue.
 *
 * Mock stack mirrors tool-part-run-location.test.tsx, plus a servers map and a
 * settable theme.
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

const themeState = vi.hoisted(() => ({
  themeMode: "light" as "light" | "dark",
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) =>
    selector({ themeMode: themeState.themeMode }),
}));

vi.mock("@/stores/widget-debug-store", () => ({
  useWidgetDebugStore: (selector: any) => selector({ widgets: new Map() }),
}));

// `current: null` models rendering outside AppStateProvider — the eval trace
// viewer and widget replay both do, and so do the sibling tool-part tests.
const appState = vi.hoisted(() => ({
  current: null as { servers: Record<string, unknown> } | null,
}));
vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () => appState.current,
}));

vi.mock("../../thread-helpers", () => ({
  getToolNameFromType: () => "echo",
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

const ICON_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E";

const basePart = {
  type: "tool-invocation" as const,
  toolName: "echo",
  toolCallId: "call-1",
  state: "output-available",
  input: { text: "hi" },
  output: {},
};

function serverWithIcon(name: string) {
  return {
    name,
    initializationInfo: {
      serverVersion: { name, version: "1.0.0", icons: [{ src: ICON_SRC }] },
    },
  };
}

function renderToolPart(extra: Record<string, unknown> = {}) {
  return render(
    <ToolPart
      part={{ ...basePart } as any}
      uiType="mcp-apps"
      {...(extra as any)}
    />,
  );
}

function icon() {
  return screen.getByTestId("tool-server-icon");
}

describe("ToolPart server branding", () => {
  beforeEach(() => {
    themeState.themeMode = "light";
    appState.current = { servers: {} };
  });

  it("renders the connected server's own icon when it declares one", () => {
    appState.current = { servers: { branded: serverWithIcon("branded") } };
    renderToolPart({ serverId: "branded" });
    expect(icon()).toHaveAttribute("src", ICON_SRC);
  });

  it("falls back to the generic MCP mark when the server declares no icon", () => {
    appState.current = { servers: { plain: { name: "plain" } } };
    renderToolPart({ serverId: "plain" });
    expect(icon()).toHaveAttribute("src", "/mcp.svg");
  });

  it("falls back when the tool is not attributed to any server", () => {
    appState.current = { servers: { branded: serverWithIcon("branded") } };
    renderToolPart({});
    expect(icon()).toHaveAttribute("src", "/mcp.svg");
  });

  it("falls back when the server is not in the map", () => {
    appState.current = { servers: {} };
    renderToolPart({ serverId: "gone" });
    expect(icon()).toHaveAttribute("src", "/mcp.svg");
  });

  it("falls back when rendered outside AppStateProvider", () => {
    appState.current = null;
    renderToolPart({ serverId: "branded" });
    expect(icon()).toHaveAttribute("src", "/mcp.svg");
  });

  it("falls back to the generic mark when the server icon fails to load", () => {
    appState.current = { servers: { branded: serverWithIcon("branded") } };
    renderToolPart({ serverId: "branded" });
    expect(icon()).toHaveAttribute("src", ICON_SRC);

    fireEvent.error(icon());
    expect(icon()).toHaveAttribute("src", "/mcp.svg");
  });

  it("inverts the generic mark in dark mode but never a server's own icon", () => {
    themeState.themeMode = "dark";
    appState.current = { servers: { plain: { name: "plain" } } };
    const plain = renderToolPart({ serverId: "plain" });
    expect(icon().className).toContain("invert");
    plain.unmount();

    appState.current = { servers: { branded: serverWithIcon("branded") } };
    renderToolPart({ serverId: "branded" });
    expect(icon().className).not.toContain("invert");
  });
});
