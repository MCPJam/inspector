import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ResourcesTab } from "../ResourcesTab";
import type { MCPServerConfig } from "@mcpjam/sdk";

// Mock APIs
const mockListResources = vi.fn();
const mockReadResource = vi.fn();

vi.mock("@/lib/apis/mcp-resources-api", () => ({
  listResources: (...args: unknown[]) => mockListResources(...args),
  readResource: (...args: unknown[]) => mockReadResource(...args),
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

describe("ResourcesTab", () => {
  const createServerConfig = (): MCPServerConfig =>
    ({
      transportType: "stdio",
      command: "node",
      args: ["server.js"],
    }) as MCPServerConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListResources.mockResolvedValue({ resources: [] });
    mockReadResource.mockResolvedValue({ content: null });
  });

  describe("empty state", () => {
    it("shows empty state when no server config provided", () => {
      render(<ResourcesTab />);

      expect(screen.getByText("No Server Selected")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Connect to an MCP server to browse and explore its available resources.",
        ),
      ).toBeInTheDocument();
    });

    it("shows empty state when serverConfig is undefined", () => {
      render(
        <ResourcesTab serverConfig={undefined} serverName="test-server" />,
      );

      expect(screen.getByText("No Server Selected")).toBeInTheDocument();
    });
  });

  describe("resource fetching", () => {
    it("fetches resources when server is configured", async () => {
      const serverConfig = createServerConfig();

      mockListResources.mockResolvedValue({
        resources: [{ name: "test.txt", uri: "file:///test.txt" }],
      });

      render(
        <ResourcesTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(mockListResources).toHaveBeenCalledWith(
          "test-server",
          undefined,
        );
      });
    });

    it("displays resources after fetching", async () => {
      const serverConfig = createServerConfig();

      mockListResources.mockResolvedValue({
        resources: [
          {
            name: "config.json",
            uri: "file:///config.json",
            description: "Configuration file",
          },
          {
            name: "data.csv",
            uri: "file:///data.csv",
          },
        ],
      });

      render(
        <ResourcesTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByText("config.json")).toBeInTheDocument();
        expect(screen.getByText("data.csv")).toBeInTheDocument();
      });
    });

    it("displays resource count", async () => {
      const serverConfig = createServerConfig();

      mockListResources.mockResolvedValue({
        resources: [
          { name: "file1.txt", uri: "file:///file1.txt" },
          { name: "file2.txt", uri: "file:///file2.txt" },
        ],
      });

      render(
        <ResourcesTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByText("2")).toBeInTheDocument();
      });
    });

    it("shows no resources message when list is empty", async () => {
      const serverConfig = createServerConfig();

      mockListResources.mockResolvedValue({ resources: [] });

      render(
        <ResourcesTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByText("No resources available")).toBeInTheDocument();
      });
    });
  });

  describe("resource selection", () => {
    it("shows select resource prompt when no resource selected", async () => {
      const serverConfig = createServerConfig();

      mockListResources.mockResolvedValue({
        resources: [{ name: "test.txt", uri: "file:///test.txt" }],
      });

      render(
        <ResourcesTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByText("No selection")).toBeInTheDocument();
      });
    });

    it("selects resource and auto-reads when clicked", async () => {
      const serverConfig = createServerConfig();

      mockListResources.mockResolvedValue({
        resources: [
          {
            name: "test.txt",
            uri: "file:///test.txt",
            description: "Test file",
          },
        ],
      });

      mockReadResource.mockResolvedValue({
        content: {
          contents: [{ type: "text", text: "File content" }],
        },
      });

      render(
        <ResourcesTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByText("test.txt")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("test.txt"));

      // Resource is auto-read when clicked
      await waitFor(() => {
        expect(mockReadResource).toHaveBeenCalledWith(
          "test-server",
          "file:///test.txt",
        );
      });
    });
  });

  describe("reading resources", () => {
    it("reads resource automatically when clicked", async () => {
      const serverConfig = createServerConfig();

      mockListResources.mockResolvedValue({
        resources: [{ name: "test.txt", uri: "file:///test.txt" }],
      });

      mockReadResource.mockResolvedValue({
        content: {
          contents: [{ type: "text", text: "Hello World" }],
        },
      });

      render(
        <ResourcesTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByText("test.txt")).toBeInTheDocument();
      });

      // Clicking the resource auto-reads it
      fireEvent.click(screen.getByText("test.txt"));

      await waitFor(() => {
        expect(mockReadResource).toHaveBeenCalledWith(
          "test-server",
          "file:///test.txt",
        );
      });
    });

    it("displays error when read fails", async () => {
      const serverConfig = createServerConfig();

      mockListResources.mockResolvedValue({
        resources: [{ name: "test.txt", uri: "file:///test.txt" }],
      });

      mockReadResource.mockRejectedValue(new Error("Resource not found"));

      render(
        <ResourcesTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByText("test.txt")).toBeInTheDocument();
      });

      // Clicking auto-reads, which will fail
      fireEvent.click(screen.getByText("test.txt"));

      await waitFor(() => {
        expect(screen.getByText(/Error reading resource/i)).toBeInTheDocument();
      });
    });
  });

  describe("refresh functionality", () => {
    it("refreshes resources when refresh button is clicked", async () => {
      const serverConfig = createServerConfig();

      mockListResources.mockResolvedValue({ resources: [] });

      render(
        <ResourcesTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(mockListResources).toHaveBeenCalledTimes(1);
      });

      // Find and click refresh button
      const buttons = screen.getAllByRole("button");
      const refreshButton = buttons.find((btn) =>
        btn.querySelector(".lucide-refresh-cw"),
      );

      if (refreshButton) {
        fireEvent.click(refreshButton);

        await waitFor(() => {
          expect(mockListResources).toHaveBeenCalledTimes(2);
        });
      }
    });
  });

  describe("resource descriptions", () => {
    it("displays resource description when available", async () => {
      const serverConfig = createServerConfig();

      mockListResources.mockResolvedValue({
        resources: [
          {
            name: "config.json",
            uri: "file:///config.json",
            description: "Application configuration file",
          },
        ],
      });

      render(
        <ResourcesTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(
          screen.getByText("Application configuration file"),
        ).toBeInTheDocument();
      });
    });
  });

  describe("pagination", () => {
    it("handles resources with cursor", async () => {
      const serverConfig = createServerConfig();

      mockListResources.mockResolvedValue({
        resources: [{ name: "file1.txt", uri: "file:///file1.txt" }],
        nextCursor: "cursor123",
      });

      render(
        <ResourcesTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByText("file1.txt")).toBeInTheDocument();
      });
    });
  });
});
