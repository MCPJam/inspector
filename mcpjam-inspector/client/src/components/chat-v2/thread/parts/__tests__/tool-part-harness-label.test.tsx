import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * A harness built-in's card says what the call did ("bash  Run npm test"),
 * and its approval pill shows what will literally run. Mock stack mirrors
 * tool-part-run-location.test.tsx; `getToolNameFromType` returns the name
 * each test sets.
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
// Dark-launch flag: the pill is part of the local-engine rollout. ON by
// default so the pill rows test the pill; the flag-off row flips it.
const flagState = vi.hoisted(() => ({ localComputerEnabled: true }));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useLocalComputerEnabled: () => flagState.localComputerEnabled,
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

const part = (
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  ({
    type: "tool-invocation",
    toolCallId: "call-1",
    state: "output-available",
    input,
    output: {},
    ...extra,
  }) as any;

describe("ToolPart harness step label", () => {
  it("a built-in's card says what it did, after the tool's own name", () => {
    toolNameState.name = "bash";
    render(
      <ToolPart
        part={part({
          command: "rg -n scheduleRetry src",
          commandActions: [{ type: "search", query: "scheduleRetry" }],
        })}
      />,
    );
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByTestId("tool-step-detail")).toHaveTextContent(
      "scheduleRetry",
    );
  });

  it("an MCP server's tool keeps its plain header, even under a built-in's name", () => {
    toolNameState.name = "read";
    try {
      render(<ToolPart part={part({ file_path: "/a.ts" })} serverId="srv" />);
      expect(screen.queryByTestId("tool-step-detail")).toBeNull();
      expect(screen.queryByText("Read")).toBeNull();
    } finally {
      toolNameState.name = "bash";
    }
  });

  it("the approval pill shows the literal command, not the model's description", () => {
    toolNameState.name = "bash";
    render(
      <ToolPart
        part={part(
          {
            command: "rm -rf build && npm test",
            description: "Run the tests",
          },
          { state: "approval-requested", output: undefined },
        )}
        approvalId="ap-1"
        onApprove={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.getByTestId("tool-approval-target")).toHaveTextContent(
      "rm -rf build && npm test",
    );
    expect(screen.queryByText("Run the tests")).toBeNull();
  });
});
