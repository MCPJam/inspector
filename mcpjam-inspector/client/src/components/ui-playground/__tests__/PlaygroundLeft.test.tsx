import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { PlaygroundLeft } from "../PlaygroundLeft";

vi.mock("../TabHeader", () => ({
  TabHeader: () => <div data-testid="tab-header" />,
}));

vi.mock("../ToolList", () => ({
  ToolList: ({
    toolNames,
    onSelectTool,
  }: {
    toolNames: string[];
    onSelectTool: (name: string) => void;
  }) => (
    <div data-testid="tool-list">
      {toolNames.map((name) => (
        <button key={name} type="button" onClick={() => onSelectTool(name)}>
          {name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("../SelectedToolHeader", () => ({
  SelectedToolHeader: ({
    toolName,
    onExpand,
  }: {
    toolName: string;
    onExpand: () => void;
  }) => (
    <div data-testid="selected-tool-header">
      <span>{toolName}</span>
      <button type="button" onClick={onExpand} aria-label="Expand tool list">
        Expand
      </button>
    </div>
  ),
}));

vi.mock("../ParametersForm", () => ({
  ParametersForm: () => <div data-testid="parameters-form" />,
}));

vi.mock("../../ui/schema-viewer", () => ({
  SchemaViewer: () => <div data-testid="schema-viewer" />,
}));

vi.mock("../../logger-view", () => ({
  LoggerView: () => <div data-testid="logger-view" />,
}));

vi.mock("../../ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div />,
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  detectUiTypeFromTool: vi.fn().mockReturnValue(null),
  UIType: { OPENAI_SDK_AND_MCP_APPS: "both" },
}));

const defaultProps = {
  tools: {} as Record<string, Tool>,
  selectedToolName: null as string | null,
  fetchingTools: false,
  onRefresh: vi.fn(),
  onSelectTool: vi.fn(),
  formFields: [],
  onFieldChange: vi.fn(),
  onToggleField: vi.fn(),
  isExecuting: false,
  onExecute: vi.fn(),
  onSave: vi.fn(),
  savedRequests: [],
  highlightedRequestId: null,
  onLoadRequest: vi.fn(),
  onRenameRequest: vi.fn(),
  onDuplicateRequest: vi.fn(),
  onDeleteRequest: vi.fn(),
};

const makeTool = (name: string): Tool =>
  ({
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
  }) as Tool;

describe("PlaygroundLeft", () => {
  it("shows tool list when no tool is selected", () => {
    render(<PlaygroundLeft {...defaultProps} selectedToolName={null} />);
    expect(screen.getByTestId("tool-list")).toBeInTheDocument();
  });

  it("does not crash when selected tool is missing from tools map", () => {
    expect(() =>
      render(
        <PlaygroundLeft
          {...defaultProps}
          tools={{}}
          selectedToolName="deleted-tool"
        />,
      ),
    ).not.toThrow();
  });

  it("reopens the same tool immediately after expanding back to the list", () => {
    const selectionCalls: Array<string | null> = [];

    function TestHarness() {
      const [selectedToolName, setSelectedToolName] = useState<string | null>(
        "read_me",
      );

      return (
        <PlaygroundLeft
          {...defaultProps}
          tools={{ read_me: makeTool("read_me") }}
          selectedToolName={selectedToolName}
          onSelectTool={(name) => {
            selectionCalls.push(name);
            setSelectedToolName(name);
          }}
        />
      );
    }

    render(<TestHarness />);

    expect(screen.getByTestId("selected-tool-header")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand tool list" }));
    expect(screen.getByTestId("tool-list")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "read_me" }));

    expect(screen.getByTestId("selected-tool-header")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-list")).not.toBeInTheDocument();
    expect(selectionCalls).toEqual(["read_me"]);
    expect(selectionCalls).not.toContain(null);
  });
});
