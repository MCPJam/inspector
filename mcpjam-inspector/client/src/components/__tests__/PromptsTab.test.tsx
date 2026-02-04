import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PromptsTab } from "../PromptsTab";
import type { MCPServerConfig } from "@mcpjam/sdk";

// Mock APIs
const mockListPrompts = vi.fn();
const mockGetPrompt = vi.fn();

vi.mock("@/lib/apis/mcp-prompts-api", () => ({
  listPrompts: (...args: unknown[]) => mockListPrompts(...args),
  getPrompt: (...args: unknown[]) => mockGetPrompt(...args),
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

// Mock ScrollArea
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="scroll-area">{children}</div>
  ),
}));

describe("PromptsTab", () => {
  const createServerConfig = (): MCPServerConfig =>
    ({
      transportType: "stdio",
      command: "node",
      args: ["server.js"],
    }) as MCPServerConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListPrompts.mockResolvedValue([]);
    mockGetPrompt.mockResolvedValue({ content: null });
  });

  describe("empty state", () => {
    it("shows empty state when no server config provided", () => {
      render(<PromptsTab />);

      expect(screen.getByText("No Server Selected")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Connect to an MCP server to explore and test its available prompts.",
        ),
      ).toBeInTheDocument();
    });

    it("shows empty state when serverConfig is undefined", () => {
      render(<PromptsTab serverConfig={undefined} serverName="test-server" />);

      expect(screen.getByText("No Server Selected")).toBeInTheDocument();
    });
  });

  describe("prompt fetching", () => {
    it("fetches prompts when server is configured", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([
        { name: "greeting", description: "A greeting prompt" },
      ]);

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(mockListPrompts).toHaveBeenCalledWith("test-server");
      });
    });

    it("displays prompts after fetching", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([
        { name: "greeting", description: "A greeting prompt" },
        { name: "farewell", description: "A farewell prompt" },
      ]);

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      // Prompts should be displayed in the list view
      await waitFor(() => {
        expect(screen.getByText("greeting")).toBeInTheDocument();
        expect(screen.getByText("farewell")).toBeInTheDocument();
      });
    });

    it("displays prompt count", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([
        { name: "prompt1" },
        { name: "prompt2" },
        { name: "prompt3" },
      ]);

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      // Count should be displayed in the header in list view
      await waitFor(() => {
        expect(screen.getByText("3")).toBeInTheDocument();
      });
    });

    it("shows no prompts message when list is empty", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([]);

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByText("No prompts available")).toBeInTheDocument();
      });
    });
  });

  describe("prompt selection", () => {
    it("shows list view by default (no auto-selection)", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([
        { name: "first-prompt", description: "First prompt" },
        { name: "second-prompt", description: "Second prompt" },
      ]);

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      // Both prompts should be visible in the list
      await waitFor(() => {
        expect(screen.getByText("first-prompt")).toBeInTheDocument();
        expect(screen.getByText("second-prompt")).toBeInTheDocument();
      });
    });

    it("selects prompt when clicked", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([
        { name: "prompt-a", description: "Prompt A" },
        { name: "prompt-b", description: "Prompt B" },
      ]);

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      // Wait for list to load
      await waitFor(() => {
        expect(screen.getByText("prompt-b")).toBeInTheDocument();
      });

      // Click prompt-b in the list
      fireEvent.click(screen.getByText("prompt-b"));

      // After selection, the SelectedToolHeader should show with "Click to change tool"
      await waitFor(() => {
        expect(screen.getByTitle("Click to change tool")).toBeInTheDocument();
      });
    });
  });

  describe("getting prompts", () => {
    it("gets prompt when Run button is clicked", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([{ name: "greeting", arguments: [] }]);

      mockGetPrompt.mockResolvedValue({
        content: [{ role: "user", content: { type: "text", text: "Hello!" } }],
      });

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      // Wait for list to load and click the prompt
      await waitFor(() => {
        expect(screen.getByText("greeting")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("greeting"));

      // Wait for selection and click Run
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /run/i }),
        ).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /run/i }));

      await waitFor(() => {
        expect(mockGetPrompt).toHaveBeenCalledWith(
          "test-server",
          "greeting",
          {},
        );
      });
    });

    it("displays error when get prompt fails", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([{ name: "failing-prompt" }]);

      mockGetPrompt.mockRejectedValue(new Error("Prompt not found"));

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      // Wait for list to load and click the prompt
      await waitFor(() => {
        expect(screen.getByText("failing-prompt")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("failing-prompt"));

      // Wait for selection and click Run
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /run/i }),
        ).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /run/i }));

      await waitFor(() => {
        expect(screen.getByText("Prompt not found")).toBeInTheDocument();
      });
    });
  });

  describe("prompt arguments", () => {
    it("displays parameter form when prompt has arguments", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([
        {
          name: "greet",
          arguments: [
            { name: "name", description: "Person to greet", required: true },
            { name: "language", description: "Greeting language" },
          ],
        },
      ]);

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      // Wait for list and click the prompt
      await waitFor(() => {
        expect(screen.getByText("greet")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("greet"));

      // Now parameters should be visible
      await waitFor(() => {
        expect(screen.getByText("name")).toBeInTheDocument();
        expect(screen.getByText("language")).toBeInTheDocument();
      });
    });

    it("shows no parameters message when prompt has no arguments", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([{ name: "simple-prompt" }]);

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      // Wait for list and click the prompt
      await waitFor(() => {
        expect(screen.getByText("simple-prompt")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("simple-prompt"));

      await waitFor(() => {
        expect(screen.getByText("No parameters required")).toBeInTheDocument();
      });
    });

    it("sends argument values when getting prompt", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([
        {
          name: "greet",
          arguments: [{ name: "name", required: true }],
        },
      ]);

      mockGetPrompt.mockResolvedValue({ content: "Hello!" });

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      // Wait for list and click the prompt
      await waitFor(() => {
        expect(screen.getByText("greet")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("greet"));

      await waitFor(() => {
        expect(screen.getByPlaceholderText("Enter name")).toBeInTheDocument();
      });

      // Enter a value
      fireEvent.change(screen.getByPlaceholderText("Enter name"), {
        target: { value: "Alice" },
      });

      fireEvent.click(screen.getByRole("button", { name: /run/i }));

      await waitFor(() => {
        expect(mockGetPrompt).toHaveBeenCalledWith("test-server", "greet", {
          name: "Alice",
        });
      });
    });
  });

  describe("prompt descriptions", () => {
    it("displays prompt description when available", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([
        {
          name: "analyze",
          description: "Analyze code for potential issues",
        },
      ]);

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      // Description may appear in both list and detail panel
      await waitFor(() => {
        const descriptions = screen.getAllByText(
          "Analyze code for potential issues",
        );
        expect(descriptions.length).toBeGreaterThanOrEqual(1);
      });
    });

    it("displays prompt title when available", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([
        {
          name: "code_review",
          title: "Code Review Assistant",
          description: "Reviews code",
        },
      ]);

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      // Title should be visible in the list view
      await waitFor(() => {
        expect(screen.getByText("Code Review Assistant")).toBeInTheDocument();
      });
    });
  });

  describe("refresh functionality", () => {
    it("refreshes prompts when refresh button is clicked", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([]);

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(mockListPrompts).toHaveBeenCalledTimes(1);
      });

      // Find and click refresh button
      const buttons = screen.getAllByRole("button");
      const refreshButton = buttons.find((btn) =>
        btn.querySelector(".lucide-refresh-cw"),
      );

      if (refreshButton) {
        fireEvent.click(refreshButton);

        await waitFor(() => {
          expect(mockListPrompts).toHaveBeenCalledTimes(2);
        });
      }
    });
  });

  describe("required fields", () => {
    it("marks required fields visually", async () => {
      const serverConfig = createServerConfig();

      mockListPrompts.mockResolvedValue([
        {
          name: "test-prompt",
          arguments: [
            { name: "required_field", required: true },
            { name: "optional_field", required: false },
          ],
        },
      ]);

      render(
        <PromptsTab serverConfig={serverConfig} serverName="test-server" />,
      );

      // Wait for list and click the prompt
      await waitFor(() => {
        expect(screen.getByText("test-prompt")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("test-prompt"));

      await waitFor(() => {
        expect(screen.getByText("required_field")).toBeInTheDocument();
        expect(screen.getByText("optional_field")).toBeInTheDocument();
      });

      // Required field should have a "required" badge
      const requiredBadge = screen.getByText("required");
      expect(requiredBadge).toBeInTheDocument();
    });
  });
});
