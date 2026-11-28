import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * A result the server marked `isError: true` reads as a failure on the card:
 * a red row with the error text, above the payload, without expanding.
 *
 * Mock stack mirrors tool-part-web-search-refusal.test.tsx.
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

const toolNameState = vi.hoisted(() => ({ name: "get_issue" }));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useLocalComputerEnabled: () => false,
}));
// `importOriginal` rather than a bare factory: this module re-exports the
// package's graph-free `@mcpjam/chat-ui/thread-helpers` subpath, and the parts
// this file does not care about (notably `readTraceDisplayText`, which decides
// whether a readable tool result is shown at all) have to behave like the real
// thing rather than be re-stubbed in every test file that shadows one helper.
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

const part = (output: unknown) =>
  ({
    type: "tool-invocation",
    toolName: "get_issue",
    toolCallId: "call-1",
    state: "output-available",
    input: { id: "42" },
    output,
  }) as any;

describe("ToolPart isError result", () => {
  it("shows the error text in a red row above the payload", () => {
    render(
      <ToolPart
        part={part({
          content: [{ type: "text", text: "Issue 42 not found" }],
          isError: true,
        })}
      />,
    );
    const row = screen.getByTestId("tool-part-result-error");
    expect(row).toHaveTextContent("Issue 42 not found");
    expect(row.className).toContain("text-destructive");

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    const payload = screen.getAllByTestId("json-editor").at(-1)!;
    expect(
      row.compareDocumentPosition(payload) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("still marks an error result that carries no text", () => {
    render(<ToolPart part={part({ content: [], isError: true })} />);
    expect(screen.getByTestId("tool-part-result-error")).toHaveTextContent(
      "The tool returned an error.",
    );
  });

  it("shows no error row for a successful result", () => {
    render(
      <ToolPart
        part={part({ content: [{ type: "text", text: "Issue 42" }] })}
      />,
    );
    expect(
      screen.queryByTestId("tool-part-result-error"),
    ).not.toBeInTheDocument();
  });
});
