import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolList } from "../ToolList";

vi.mock("../../ui/search-input", () => ({
  SearchInput: ({
    value,
    onValueChange,
    placeholder,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    placeholder: string;
  }) => (
    <input
      aria-label="search tools"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    />
  ),
}));

vi.mock("../../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const makeTool = (name: string, meta?: Record<string, unknown>): Tool =>
  ({
    name,
    description: `${name} description`,
    inputSchema: {
      type: "object",
      properties: {},
    },
    ...(meta ? { _meta: meta } : {}),
  }) as Tool;

const defaultProps = {
  toolNames: [] as string[],
  filteredToolNames: [] as string[],
  tools: {} as Record<string, Tool>,
  selectedToolName: null as string | null,
  fetchingTools: false,
  searchQuery: "",
  onSearchQueryChange: vi.fn(),
  onSelectTool: vi.fn(),
  onCollapseList: vi.fn(),
};

describe("ToolList", () => {
  // ── Selection behavior ──

  it("allows selecting a non-UI tool", () => {
    const onSelectTool = vi.fn();

    render(
      <ToolList
        {...defaultProps}
        tools={{ read_me: makeTool("read_me") }}
        toolNames={["read_me"]}
        filteredToolNames={["read_me"]}
        onSelectTool={onSelectTool}
      />,
    );

    const toolButton = screen.getByRole("button", { name: /read_me/i });
    expect(toolButton).toBeEnabled();

    fireEvent.click(toolButton);
    expect(onSelectTool).toHaveBeenCalledWith("read_me");
  });

  it("allows selecting a UI-capable tool", () => {
    const onSelectTool = vi.fn();

    render(
      <ToolList
        {...defaultProps}
        tools={{
          render_chart: makeTool("render_chart", {
            "openai/outputTemplate": "ui://chart/template.html",
          }),
        }}
        toolNames={["render_chart"]}
        filteredToolNames={["render_chart"]}
        onSelectTool={onSelectTool}
      />,
    );

    const toolButton = screen.getByRole("button", { name: /render_chart/i });
    expect(toolButton).toBeEnabled();

    fireEvent.click(toolButton);
    expect(onSelectTool).toHaveBeenCalledWith("render_chart");
  });

  it("collapses when clicking an already selected tool", () => {
    const onCollapseList = vi.fn();

    render(
      <ToolList
        {...defaultProps}
        tools={{ read_me: makeTool("read_me") }}
        toolNames={["read_me"]}
        filteredToolNames={["read_me"]}
        selectedToolName="read_me"
        onCollapseList={onCollapseList}
      />,
    );

    const toolButton = screen.getByRole("button", { name: /read_me/i });
    fireEvent.click(toolButton);

    expect(onCollapseList).toHaveBeenCalled();
  });

  it("applies selected styling to the active tool", () => {
    render(
      <ToolList
        {...defaultProps}
        tools={{ read_me: makeTool("read_me") }}
        toolNames={["read_me"]}
        filteredToolNames={["read_me"]}
        selectedToolName="read_me"
      />,
    );

    const toolButton = screen.getByRole("button", { name: /read_me/i });
    expect(toolButton.className).toContain("bg-primary/10");
  });

  it("does not apply selected styling to unselected tools", () => {
    render(
      <ToolList
        {...defaultProps}
        tools={{ read_me: makeTool("read_me") }}
        toolNames={["read_me"]}
        filteredToolNames={["read_me"]}
        selectedToolName={null}
      />,
    );

    const toolButton = screen.getByRole("button", { name: /read_me/i });
    expect(toolButton.className).not.toContain("bg-primary/10");
  });

  // ── Disabled tooltip removal ──

  it("does not render disabled tooltip copy for non-UI tools", () => {
    render(
      <ToolList
        {...defaultProps}
        tools={{ read_me: makeTool("read_me") }}
        toolNames={["read_me"]}
        filteredToolNames={["read_me"]}
      />,
    );

    expect(
      screen.queryByText("This tool runs in chat only"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("This tool doesn't support UI rendering"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("(No ChatGPT Apps or MCP Apps metadata)"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("(No UI metadata to render a widget)"),
    ).not.toBeInTheDocument();
  });

  // ── UI type badges ──

  it("shows ChatGPT Apps badge for OpenAI SDK tools", () => {
    render(
      <ToolList
        {...defaultProps}
        tools={{
          my_tool: makeTool("my_tool", {
            "openai/outputTemplate": "ui://widget/template.html",
          }),
        }}
        toolNames={["my_tool"]}
        filteredToolNames={["my_tool"]}
      />,
    );

    expect(screen.getByAltText("ChatGPT Apps")).toBeInTheDocument();
    expect(screen.queryByAltText("MCP Apps")).not.toBeInTheDocument();
  });

  it("shows MCP Apps badge for MCP Apps tools", () => {
    render(
      <ToolList
        {...defaultProps}
        tools={{
          my_tool: makeTool("my_tool", {
            ui: { resourceUri: "ui://app/render.html" },
          }),
        }}
        toolNames={["my_tool"]}
        filteredToolNames={["my_tool"]}
      />,
    );

    expect(screen.getByAltText("MCP Apps")).toBeInTheDocument();
    expect(screen.queryByAltText("ChatGPT Apps")).not.toBeInTheDocument();
  });

  it("shows both badges for tools supporting OpenAI SDK and MCP Apps", () => {
    render(
      <ToolList
        {...defaultProps}
        tools={{
          my_tool: makeTool("my_tool", {
            "openai/outputTemplate": "ui://widget/template.html",
            ui: { resourceUri: "ui://app/render.html" },
          }),
        }}
        toolNames={["my_tool"]}
        filteredToolNames={["my_tool"]}
      />,
    );

    expect(screen.getByAltText("ChatGPT Apps")).toBeInTheDocument();
    expect(screen.getByAltText("MCP Apps")).toBeInTheDocument();
  });

  it("does not show any badges for non-UI tools", () => {
    render(
      <ToolList
        {...defaultProps}
        tools={{ plain: makeTool("plain") }}
        toolNames={["plain"]}
        filteredToolNames={["plain"]}
      />,
    );

    expect(screen.queryByAltText("ChatGPT Apps")).not.toBeInTheDocument();
    expect(screen.queryByAltText("MCP Apps")).not.toBeInTheDocument();
  });

  // ── Description rendering ──

  it("renders tool description when provided", () => {
    render(
      <ToolList
        {...defaultProps}
        tools={{ read_me: makeTool("read_me") }}
        toolNames={["read_me"]}
        filteredToolNames={["read_me"]}
      />,
    );

    expect(screen.getByText("read_me description")).toBeInTheDocument();
  });

  it("does not render description paragraph when description is absent", () => {
    const toolWithoutDesc = {
      name: "no_desc",
      inputSchema: { type: "object" as const, properties: {} },
    } as Tool;

    render(
      <ToolList
        {...defaultProps}
        tools={{ no_desc: toolWithoutDesc }}
        toolNames={["no_desc"]}
        filteredToolNames={["no_desc"]}
      />,
    );

    const button = screen.getByRole("button", { name: /no_desc/i });
    expect(button.querySelector("p")).toBeNull();
  });

  // ── Empty / loading states ──

  it("shows loading state when fetching tools", () => {
    render(<ToolList {...defaultProps} fetchingTools={true} />);

    expect(screen.getByText("Loading tools...")).toBeInTheDocument();
  });

  it("shows empty message when no tools are available", () => {
    render(
      <ToolList {...defaultProps} toolNames={[]} filteredToolNames={[]} />,
    );

    expect(
      screen.getByText(
        "No tools found. Try refreshing and make sure the server is running.",
      ),
    ).toBeInTheDocument();
  });

  it("shows search-miss message when filter yields no results", () => {
    render(
      <ToolList
        {...defaultProps}
        tools={{ read_me: makeTool("read_me") }}
        toolNames={["read_me"]}
        filteredToolNames={[]}
        searchQuery="xyz"
      />,
    );

    expect(screen.getByText("No tools match your search")).toBeInTheDocument();
  });

  // ── Multiple tools ──

  it("renders all filtered tools", () => {
    const tools = {
      alpha: makeTool("alpha"),
      beta: makeTool("beta"),
      gamma: makeTool("gamma"),
    };

    render(
      <ToolList
        {...defaultProps}
        tools={tools}
        toolNames={["alpha", "beta", "gamma"]}
        filteredToolNames={["alpha", "gamma"]}
      />,
    );

    expect(screen.getByRole("button", { name: /alpha/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^beta/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /gamma/i })).toBeInTheDocument();
  });

  // ── Search input ──

  it("calls onSearchQueryChange when typing in search", () => {
    const onSearchQueryChange = vi.fn();

    render(
      <ToolList {...defaultProps} onSearchQueryChange={onSearchQueryChange} />,
    );

    const input = screen.getByRole("textbox", { name: /search tools/i });
    fireEvent.change(input, { target: { value: "read" } });

    expect(onSearchQueryChange).toHaveBeenCalledWith("read");
  });
});
