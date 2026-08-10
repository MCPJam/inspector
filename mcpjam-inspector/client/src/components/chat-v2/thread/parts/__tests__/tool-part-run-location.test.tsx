import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * The bash card's run-location pill. Non-hosted bash turns stamp
 * `engine: "local" | "cloud"` onto the tool result; the card surfaces it so the
 * transcript says WHICH machine ran the command. Everything else — old
 * transcripts, hosted turns, the ephemeral sandbox-bash tool, non-bash tools —
 * must render nothing rather than guess.
 *
 * Mock stack mirrors tool-part-approval.test.tsx, except `getToolNameFromType`
 * returns "bash" (the pill is bash-only).
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

const toolNameState = vi.hoisted(() => ({ name: "bash" }));
vi.mock("../../thread-helpers", () => ({
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

import { ToolPart, readToolRunLocation } from "../tool-part";

const basePart = {
  type: "tool-invocation" as const,
  toolName: "bash",
  toolCallId: "call-1",
  state: "output-available",
  input: { command: "uname -a" },
  output: {},
};

function renderBash(output: unknown, extra: Record<string, unknown> = {}) {
  return render(
    <ToolPart
      part={{ ...basePart, output } as any}
      uiType="mcp-apps"
      {...(extra as any)}
    />,
  );
}

describe("readToolRunLocation", () => {
  it("reads the stamped engine on a bash result", () => {
    expect(readToolRunLocation("bash", { engine: "local" })).toBe("local");
    expect(readToolRunLocation("bash", { engine: "cloud" })).toBe("cloud");
  });

  it("ignores non-bash tools even when the field is present", () => {
    expect(readToolRunLocation("readFile", { engine: "local" })).toBeNull();
  });

  it("ignores an absent, unknown, or non-object result", () => {
    expect(readToolRunLocation("bash", { stdout: "hi" })).toBeNull();
    expect(readToolRunLocation("bash", { engine: "quantum" })).toBeNull();
    expect(readToolRunLocation("bash", null)).toBeNull();
    expect(readToolRunLocation("bash", "output")).toBeNull();
    expect(readToolRunLocation(undefined, { engine: "local" })).toBeNull();
  });
});

describe("ToolPart run-location pill", () => {
  it("renders 'this machine' for a local bash result", () => {
    renderBash({ stdout: "Linux", exitCode: 0, engine: "local" });
    expect(screen.getByTestId("tool-run-location")).toHaveTextContent(
      "this machine",
    );
  });

  it("renders 'cloud' for a cloud bash result", () => {
    renderBash({ stdout: "Linux", exitCode: 0, engine: "cloud" });
    expect(screen.getByTestId("tool-run-location")).toHaveTextContent("cloud");
  });

  it("renders on an ERROR result too — a failed command still ran somewhere", () => {
    renderBash({ error: "Command failed to run.", engine: "local" });
    expect(screen.getByTestId("tool-run-location")).toHaveTextContent(
      "this machine",
    );
  });

  it("renders nothing when the result carries no engine (old transcript / hosted)", () => {
    renderBash({ stdout: "Linux", exitCode: 0 });
    expect(screen.queryByTestId("tool-run-location")).not.toBeInTheDocument();
  });

  it("renders nothing for a non-bash tool", () => {
    toolNameState.name = "readFile";
    try {
      renderBash({ engine: "local" });
      expect(screen.queryByTestId("tool-run-location")).not.toBeInTheDocument();
    } finally {
      toolNameState.name = "bash";
    }
  });

  it("reads the RAW output, not the editable display value", () => {
    // `rawOutput` is the frozen server value; `outputValue` is what the Raw tab
    // editor shows and a user can rewrite. Provenance must follow the former.
    render(
      <ToolPart
        part={{ ...basePart, output: { engine: "cloud" } } as any}
        uiType="mcp-apps"
        rawOutput={{ engine: "local" }}
        outputValue={{ engine: "cloud" }}
      />,
    );
    expect(screen.getByTestId("tool-run-location")).toHaveTextContent(
      "this machine",
    );
  });
});
