import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Tool } from "@modelcontextprotocol/client";
import { PlaygroundLeft } from "../PlaygroundLeft";

vi.mock("../TabHeader", () => ({
  TabHeader: () => <div data-testid="tab-header" />,
}));

vi.mock("../ToolList", () => ({
  ToolList: () => <div data-testid="tool-list" />,
}));

vi.mock("../SelectedToolHeader", () => ({
  SelectedToolHeader: () => <div data-testid="selected-tool-header" />,
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
});
