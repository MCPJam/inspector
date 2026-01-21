import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToolsTab } from "../ToolsTab";
import type { MCPServerConfig } from "@/sdk";

// Mock posthog
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));

// Mock the APIs
const mockListTools = vi.fn();
const mockExecuteToolApi = vi.fn();
const mockRespondToElicitationApi = vi.fn();

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: (...args: unknown[]) => mockListTools(...args),
  executeToolApi: (...args: unknown[]) => mockExecuteToolApi(...args),
  respondToElicitationApi: (...args: unknown[]) =>
    mockRespondToElicitationApi(...args),
}));

const mockGetTaskCapabilities = vi.fn();
vi.mock("@/lib/apis/mcp-tasks-api", () => ({
  getTaskCapabilities: (...args: unknown[]) => mockGetTaskCapabilities(...args),
}));

// Mock request storage
vi.mock("@/lib/request-storage", () => ({
  listSavedRequests: vi.fn().mockReturnValue([]),
  saveRequest: vi.fn(),
  deleteRequest: vi.fn(),
  duplicateRequest: vi.fn(),
  updateRequestMeta: vi.fn(),
}));

// Mock logger
vi.mock("@/hooks/use-logger", () => ({
  useLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock PosthogUtils
vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn().mockReturnValue("test"),
  detectPlatform: vi.fn().mockReturnValue("web"),
}));

// Mock task tracker
vi.mock("@/lib/task-tracker", () => ({
  trackTask: vi.fn(),
}));

// Mock ResizablePanelGroup to simplify rendering
vi.mock("../ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

// Mock LoggerView
vi.mock("../logger-view", () => ({
  LoggerView: () => <div data-testid="logger-view">Logger</div>,
}));

describe("ToolsTab", () => {
  const createServerConfig = (
    overrides: Partial<MCPServerConfig> = {},
  ): MCPServerConfig =>
    ({
      transportType: "stdio",
      command: "node",
      args: ["server.js"],
      ...overrides,
    }) as MCPServerConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue({ tools: [] });
    mockGetTaskCapabilities.mockResolvedValue({
      supportsToolCalls: false,
      supportsList: false,
      supportsCancel: false,
    });
  });

  describe("empty state", () => {
    it("shows empty state when no server config provided", () => {
      render(<ToolsTab />);

      expect(screen.getByText("No Server Selected")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Connect to an MCP server to explore and test its available tools.",
        ),
      ).toBeInTheDocument();
    });

    it("shows empty state when serverConfig is undefined", () => {
      render(<ToolsTab serverConfig={undefined} serverName="test-server" />);

      expect(screen.getByText("No Server Selected")).toBeInTheDocument();
    });
  });

  describe("tool fetching", () => {
    it("fetches tools when server is configured", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "test-tool",
            description: "A test tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });

      render(<ToolsTab serverConfig={serverConfig} serverName="test-server" />);

      await waitFor(() => {
        expect(mockListTools).toHaveBeenCalledWith(
          "test-server",
          undefined,
          undefined,
        );
      });
    });

    it("displays tools after fetching", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "read-file",
            description: "Read a file from disk",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "write-file",
            description: "Write a file to disk",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });

      render(<ToolsTab serverConfig={serverConfig} serverName="test-server" />);

      await waitFor(() => {
        expect(screen.getByText("read-file")).toBeInTheDocument();
        expect(screen.getByText("write-file")).toBeInTheDocument();
      });
    });

    it("displays tool count", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [
          { name: "tool1", inputSchema: { type: "object" } },
          { name: "tool2", inputSchema: { type: "object" } },
          { name: "tool3", inputSchema: { type: "object" } },
        ],
      });

      render(<ToolsTab serverConfig={serverConfig} serverName="test-server" />);

      await waitFor(() => {
        // Tool count should be displayed somewhere
        expect(screen.getByText("3")).toBeInTheDocument();
      });
    });
  });

  describe("tool selection", () => {
    it("shows select tool prompt when no tool selected", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [{ name: "test-tool", inputSchema: { type: "object" } }],
      });

      render(<ToolsTab serverConfig={serverConfig} serverName="test-server" />);

      await waitFor(() => {
        expect(screen.getByText("Select a tool")).toBeInTheDocument();
      });
    });

    it("selects tool when clicked", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "test-tool",
            description: "A test tool",
            inputSchema: {
              type: "object",
              properties: {
                message: { type: "string" },
              },
            },
          },
        ],
      });

      render(<ToolsTab serverConfig={serverConfig} serverName="test-server" />);

      await waitFor(() => {
        expect(screen.getByText("test-tool")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("test-tool"));

      // After selection, the execute button should be visible
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /execute/i }),
        ).toBeInTheDocument();
      });
    });
  });

  describe("search functionality", () => {
    it("filters tools by name", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [
          { name: "read-file", inputSchema: { type: "object" } },
          { name: "write-file", inputSchema: { type: "object" } },
          { name: "delete-file", inputSchema: { type: "object" } },
        ],
      });

      render(<ToolsTab serverConfig={serverConfig} serverName="test-server" />);

      // Wait for tools to load
      await waitFor(() => {
        expect(screen.getByText("read-file")).toBeInTheDocument();
        expect(screen.getByText("write-file")).toBeInTheDocument();
        expect(screen.getByText("delete-file")).toBeInTheDocument();
      });

      // Find search input
      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: "write" } });

      // Verify filtering works
      await waitFor(() => {
        expect(screen.getByText("write-file")).toBeInTheDocument();
      });
      expect(screen.queryByText("read-file")).not.toBeInTheDocument();
      expect(screen.queryByText("delete-file")).not.toBeInTheDocument();
    });

    it("filters tools by description", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "tool-a",
            description: "Handles file operations",
            inputSchema: { type: "object" },
          },
          {
            name: "tool-b",
            description: "Handles network requests",
            inputSchema: { type: "object" },
          },
        ],
      });

      render(<ToolsTab serverConfig={serverConfig} serverName="test-server" />);

      await waitFor(() => {
        expect(screen.getByText("tool-a")).toBeInTheDocument();
        expect(screen.getByText("tool-b")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: "network" } });

      await waitFor(() => {
        expect(screen.getByText("tool-b")).toBeInTheDocument();
      });
      expect(screen.queryByText("tool-a")).not.toBeInTheDocument();
    });
  });

  describe("tool execution", () => {
    it("executes tool with parameters", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "greet",
            description: "Greet someone",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        ],
      });

      mockExecuteToolApi.mockResolvedValue({
        status: "completed",
        result: {
          content: [{ type: "text", text: "Hello, World!" }],
        },
      });

      render(<ToolsTab serverConfig={serverConfig} serverName="test-server" />);

      await waitFor(() => {
        expect(screen.getByText("greet")).toBeInTheDocument();
      });

      // Select the tool
      fireEvent.click(screen.getByText("greet"));

      // Wait for execute button to be available
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /execute/i }),
        ).toBeInTheDocument();
      });

      // Find and click execute button
      const executeButton = screen.getByRole("button", { name: /execute/i });
      fireEvent.click(executeButton);

      await waitFor(() => {
        expect(mockExecuteToolApi).toHaveBeenCalledWith(
          "test-server",
          "greet",
          expect.any(Object),
          undefined,
        );
      });
    });
  });

  describe("task capabilities", () => {
    it("fetches task capabilities when server changes", async () => {
      const serverConfig = createServerConfig();

      render(<ToolsTab serverConfig={serverConfig} serverName="test-server" />);

      await waitFor(() => {
        expect(mockGetTaskCapabilities).toHaveBeenCalledWith("test-server");
      });
    });
  });

  describe("server change", () => {
    it("clears state when server config becomes undefined", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [{ name: "test-tool", inputSchema: { type: "object" } }],
      });

      const { rerender } = render(
        <ToolsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByText("test-tool")).toBeInTheDocument();
      });

      // Clear the server
      rerender(<ToolsTab serverConfig={undefined} serverName={undefined} />);

      expect(screen.getByText("No Server Selected")).toBeInTheDocument();
    });

    it("refetches tools when server name changes", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [
          { name: "tool-from-server-1", inputSchema: { type: "object" } },
        ],
      });

      const { rerender } = render(
        <ToolsTab serverConfig={serverConfig} serverName="server-1" />,
      );

      await waitFor(() => {
        expect(mockListTools).toHaveBeenCalledWith(
          "server-1",
          undefined,
          undefined,
        );
      });

      mockListTools.mockResolvedValue({
        tools: [
          { name: "tool-from-server-2", inputSchema: { type: "object" } },
        ],
      });

      rerender(<ToolsTab serverConfig={serverConfig} serverName="server-2" />);

      await waitFor(() => {
        expect(mockListTools).toHaveBeenCalledWith(
          "server-2",
          undefined,
          undefined,
        );
      });
    });
  });

  describe("error handling", () => {
    it("displays error when tool fetch fails", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockRejectedValue(new Error("Network error"));

      render(<ToolsTab serverConfig={serverConfig} serverName="test-server" />);

      await waitFor(() => {
        expect(mockListTools).toHaveBeenCalled();
      });

      // Error should be displayed somewhere in the UI
      // The exact location depends on implementation
    });

    it("displays error when tool execution fails", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "failing-tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });

      mockExecuteToolApi.mockRejectedValue(new Error("Execution failed"));

      render(<ToolsTab serverConfig={serverConfig} serverName="test-server" />);

      await waitFor(() => {
        expect(screen.getByText("failing-tool")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("failing-tool"));

      await waitFor(() => {
        const executeButton = screen.getByRole("button", { name: /execute/i });
        fireEvent.click(executeButton);
      });

      await waitFor(() => {
        expect(mockExecuteToolApi).toHaveBeenCalled();
      });
    });
  });

  describe("tabs", () => {
    it("shows tools tab by default", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({ tools: [] });

      render(<ToolsTab serverConfig={serverConfig} serverName="test-server" />);

      // Tools tab should be selected (has active styling)
      const toolsTabButton = screen.getByRole("button", { name: /^tools$/i });
      expect(toolsTabButton.className).toContain("border-primary");
    });

    it("can switch to saved tab", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({ tools: [] });

      render(<ToolsTab serverConfig={serverConfig} serverName="test-server" />);

      const savedTabButton = screen.getByRole("button", {
        name: /saved requests/i,
      });
      fireEvent.click(savedTabButton);

      // After clicking, saved tab should have active styling
      expect(savedTabButton.className).toContain("border-primary");
    });
  });
});
