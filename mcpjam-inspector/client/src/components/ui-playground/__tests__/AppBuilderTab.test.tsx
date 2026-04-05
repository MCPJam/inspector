import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AppBuilderTab } from "../AppBuilderTab";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";

const mockToastDismiss = vi.fn();
const mockSetMcpSidebarOpen = vi.fn();

// Mock posthog
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    dismiss: (...args: unknown[]) => mockToastDismiss(...args),
  },
}));

vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({
    setOpen: mockSetMcpSidebarOpen,
  }),
}));

// Mock PosthogUtils
vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn().mockReturnValue("test"),
  detectPlatform: vi.fn().mockReturnValue("web"),
}));

// Mock APIs
const mockListTools = vi.fn();
vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: (...args: unknown[]) => mockListTools(...args),
}));

// Mock tool-form
vi.mock("@/lib/tool-form", () => ({
  generateFormFieldsFromSchema: vi.fn().mockReturnValue([]),
}));

// Mock mcp-apps-utils
vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  detectUiTypeFromTool: vi.fn().mockReturnValue(null),
  UIType: {
    OPENAI_SDK: "openai-apps",
    MCP_APPS: "mcp-apps",
    OPENAI_SDK_AND_MCP_APPS: "both",
  },
}));

// Mock preferences store
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) => {
    const state = { themeMode: "light" };
    return selector ? selector(state) : state;
  },
}));

// Mock UI Playground store
const mockUIPlaygroundStore = {
  selectedTool: null,
  tools: {},
  formFields: [],
  isExecuting: false,
  deviceType: "mobile",
  displayMode: "inline",
  globals: { locale: "en-US", theme: "light", timeZone: "UTC" },
  isSidebarVisible: true,
  setTools: vi.fn(),
  setSelectedTool: vi.fn(),
  setFormFields: vi.fn(),
  updateFormField: vi.fn(),
  updateFormFieldIsSet: vi.fn(),
  setIsExecuting: vi.fn(),
  setToolOutput: vi.fn(),
  setToolResponseMetadata: vi.fn(),
  setExecutionError: vi.fn(),
  setWidgetState: vi.fn(),
  setDeviceType: vi.fn(),
  setDisplayMode: vi.fn(),
  updateGlobal: vi.fn(),
  toggleSidebar: vi.fn(),
  setSelectedProtocol: vi.fn(),
  reset: vi.fn(),
  setSidebarVisible: vi.fn(),
};

vi.mock("@/stores/ui-playground-store", () => ({
  useUIPlaygroundStore: () => mockUIPlaygroundStore,
}));

// Mock custom hooks
vi.mock("../hooks", () => ({
  useServerKey: vi.fn().mockReturnValue("test-server-key"),
  useSavedRequests: vi.fn().mockReturnValue({
    savedRequests: [],
    highlightedRequestId: null,
    handleLoadRequest: vi.fn(),
    handleRenameRequest: vi.fn(),
    handleDuplicateRequest: vi.fn(),
    handleDeleteRequest: vi.fn(),
    openSaveDialog: vi.fn(),
    closeSaveDialog: vi.fn(),
    handleSaveDialogSubmit: vi.fn(),
    saveDialogState: {
      isOpen: false,
      defaults: { title: "", description: "" },
    },
  }),
  useToolExecution: vi.fn().mockReturnValue({
    pendingExecution: null,
    clearPendingExecution: vi.fn(),
    executeTool: vi.fn(),
  }),
}));

// Mock ResizablePanelGroup
vi.mock("../../ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

// Mock PlaygroundLeft
vi.mock("../PlaygroundLeft", () => ({
  PlaygroundLeft: ({
    tools,
    selectedToolName,
    onSelectTool,
    onExecute,
    onClose,
  }: {
    tools: Record<string, any>;
    selectedToolName: string | null;
    onSelectTool: (name: string) => void;
    onExecute: () => void;
    onClose: () => void;
  }) => (
    <div data-testid="playground-left">
      <div data-testid="tool-count">{Object.keys(tools).length} tools</div>
      {Object.entries(tools).map(([name, tool]) => (
        <button
          key={name}
          data-testid={`tool-${name}`}
          onClick={() => onSelectTool(name)}
          className={selectedToolName === name ? "selected" : ""}
        >
          {name}
        </button>
      ))}
      <button data-testid="execute-button" onClick={onExecute}>
        Execute
      </button>
      <button data-testid="close-sidebar" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

// Mock PlaygroundMain
vi.mock("../PlaygroundMain", () => ({
  PlaygroundMain: ({
    serverName,
    isExecuting,
    showPostConnectGuide,
    initialInput,
    onFirstMessageSent,
  }: {
    serverName: string;
    isExecuting: boolean;
    showPostConnectGuide?: boolean;
    initialInput?: string;
    onFirstMessageSent?: () => void;
  }) => (
    <div data-testid="playground-main">
      <span data-testid="server-name">{serverName}</span>
      {isExecuting && <span data-testid="executing">Executing...</span>}
      {initialInput && (
        <span data-testid="guided-initial-input">{initialInput}</span>
      )}
      {showPostConnectGuide && (
        <div data-testid="post-connect-guide">Post Connect Guide</div>
      )}
      {onFirstMessageSent && (
        <button data-testid="first-message-sent" onClick={onFirstMessageSent}>
          First Message Sent
        </button>
      )}
    </div>
  ),
}));

// Mock SaveRequestDialog
vi.mock("../../tools/SaveRequestDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="save-dialog">Save Dialog</div> : null,
}));

// Mock onboarding hook
const mockOnboarding = {
  phase: "dismissed" as string,
  isOverlayVisible: false,
  isGuidedPostConnect: false,
  isResolvingRemoteCompletion: false,
  isBootstrappingFirstRunConnection: false,
  connectExcalidraw: vi.fn(),
  completeOnboarding: vi.fn(),
  connectError: null as string | null,
  retryConnect: vi.fn(),
};
vi.mock("@/hooks/use-onboarding", () => ({
  useOnboarding: () => mockOnboarding,
}));

// Mock PostConnectGuide
vi.mock("../../app-builder/PostConnectGuide", () => ({
  PostConnectGuide: () => (
    <div data-testid="post-connect-guide">Post Connect Guide</div>
  ),
}));

// Mock AppBuilderSkeleton
vi.mock("../../app-builder/AppBuilderSkeleton", () => ({
  AppBuilderSkeleton: () => (
    <div data-testid="app-builder-skeleton">Skeleton</div>
  ),
}));

// Mock CollapsedPanelStrip
vi.mock("../../ui/collapsed-panel-strip", () => ({
  CollapsedPanelStrip: ({
    onOpen,
    tooltipText,
  }: {
    onOpen: () => void;
    tooltipText: string;
  }) => (
    <button data-testid="collapsed-panel" onClick={onOpen}>
      {tooltipText}
    </button>
  ),
}));

describe("AppBuilderTab", () => {
  const createServerConfig = (): MCPServerConfig =>
    ({
      transportType: "stdio",
      command: "node",
      args: ["server.js"],
    }) as MCPServerConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue({ tools: [], toolsMetadata: {} });

    // Reset store state
    Object.assign(mockUIPlaygroundStore, {
      selectedTool: null,
      tools: {},
      formFields: [],
      isExecuting: false,
      isSidebarVisible: true,
    });

    // Reset onboarding state (default: dismissed, no overlay)
    Object.assign(mockOnboarding, {
      phase: "dismissed",
      isOverlayVisible: false,
      isGuidedPostConnect: false,
      isResolvingRemoteCompletion: false,
      isBootstrappingFirstRunConnection: false,
      connectError: null,
    });
  });

  describe("empty state", () => {
    it("shows empty state when no server config provided", () => {
      render(<AppBuilderTab />);

      expect(screen.getByText("No Server Selected")).toBeInTheDocument();
      expect(
        screen.getByText("Connect to an MCP server to use the App Builder."),
      ).toBeInTheDocument();
    });

    it("shows empty state when serverConfig is undefined", () => {
      render(<AppBuilderTab serverConfig={undefined} serverName="test" />);

      expect(screen.getByText("No Server Selected")).toBeInTheDocument();
    });
  });

  describe("server connection", () => {
    it("fetches tools when server is configured", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [
          { name: "test-tool", description: "A test tool", inputSchema: {} },
        ],
        toolsMetadata: {},
      });

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(mockListTools).toHaveBeenCalledWith({ serverId: "test-server" });
      });
    });

    it("calls reset when server config is provided", async () => {
      const serverConfig = createServerConfig();

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(mockUIPlaygroundStore.reset).toHaveBeenCalled();
      });
    });

    it("sets tools in store after fetching", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [
          { name: "read_file", description: "Read a file", inputSchema: {} },
          { name: "write_file", description: "Write a file", inputSchema: {} },
        ],
        toolsMetadata: {},
      });

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(mockUIPlaygroundStore.setTools).toHaveBeenCalled();
      });
    });

    it("handles fetch error gracefully", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockRejectedValue(new Error("Network error"));

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(mockUIPlaygroundStore.setExecutionError).toHaveBeenCalledWith(
          "Network error",
        );
      });
    });
  });

  describe("layout", () => {
    it("renders playground left panel when sidebar is visible", async () => {
      const serverConfig = createServerConfig();
      mockUIPlaygroundStore.isSidebarVisible = true;

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("playground-left")).toBeInTheDocument();
      });
    });

    it("renders collapsed panel strip when sidebar is hidden", async () => {
      const serverConfig = createServerConfig();
      mockUIPlaygroundStore.isSidebarVisible = false;

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("collapsed-panel")).toBeInTheDocument();
      });
    });

    it("renders playground main panel", async () => {
      const serverConfig = createServerConfig();

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("playground-main")).toBeInTheDocument();
      });
    });

    it("passes serverName to PlaygroundMain", async () => {
      const serverConfig = createServerConfig();

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="my-server" />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("server-name")).toHaveTextContent(
          "my-server",
        );
      });
    });
  });

  describe("tool selection", () => {
    it("calls setSelectedTool when tool is clicked", async () => {
      const serverConfig = createServerConfig();
      mockUIPlaygroundStore.tools = {
        "test-tool": { name: "test-tool", inputSchema: {} },
      };

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("tool-test-tool")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("tool-test-tool"));

      expect(mockUIPlaygroundStore.setSelectedTool).toHaveBeenCalledWith(
        "test-tool",
      );
    });
  });

  describe("sidebar toggle", () => {
    it("calls toggleSidebar when close button is clicked", async () => {
      const serverConfig = createServerConfig();
      mockUIPlaygroundStore.isSidebarVisible = true;

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("close-sidebar")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("close-sidebar"));

      expect(mockUIPlaygroundStore.toggleSidebar).toHaveBeenCalled();
    });

    it("calls toggleSidebar when collapsed panel is clicked", async () => {
      const serverConfig = createServerConfig();
      mockUIPlaygroundStore.isSidebarVisible = false;

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("collapsed-panel")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("collapsed-panel"));

      expect(mockUIPlaygroundStore.toggleSidebar).toHaveBeenCalled();
    });
  });

  describe("tool execution", () => {
    it("shows executing state when isExecuting is true", async () => {
      const serverConfig = createServerConfig();
      mockUIPlaygroundStore.isExecuting = true;

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("executing")).toBeInTheDocument();
      });
    });
  });

  describe("display context source of truth", () => {
    it("does not mirror theme into playground globals", async () => {
      const serverConfig = createServerConfig();

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(mockListTools).toHaveBeenCalledWith({
          serverId: "test-server",
        });
      });

      expect(mockUIPlaygroundStore.updateGlobal).not.toHaveBeenCalledWith(
        "theme",
        "light",
      );
    });
  });

  describe("onboarding", () => {
    it("renders bootstrap skeleton before the Excalidraw server row exists on first run", () => {
      mockOnboarding.isBootstrappingFirstRunConnection = true;

      render(<AppBuilderTab />);

      expect(screen.getByTestId("app-builder-skeleton")).toBeInTheDocument();
    });

    it("renders only the skeleton while signed-in onboarding state is resolving", () => {
      mockOnboarding.isResolvingRemoteCompletion = true;

      render(<AppBuilderTab />);

      expect(screen.getByTestId("app-builder-skeleton")).toBeInTheDocument();
      expect(screen.queryByText("No Server Selected")).not.toBeInTheDocument();
    });

    it("shows App Builder while Excalidraw is connecting when not bootstrapping", () => {
      const serverConfig = createServerConfig();
      mockOnboarding.phase = "connecting_excalidraw";
      mockOnboarding.isOverlayVisible = false;
      mockOnboarding.isBootstrappingFirstRunConnection = false;

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      expect(screen.getByTestId("playground-main")).toBeInTheDocument();
      expect(screen.queryByTestId("app-builder-skeleton")).not.toBeInTheDocument();
    });

    it("does not render the post-connect guide shell (NUX uses prefilled prompt only)", async () => {
      const serverConfig = createServerConfig();
      mockOnboarding.phase = "connected_guided";
      mockOnboarding.isGuidedPostConnect = true;

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(
          screen.queryByTestId("post-connect-guide"),
        ).not.toBeInTheDocument();
      });
    });

    it("passes the seeded guided prompt to PlaygroundMain while post-connect onboarding is active", async () => {
      const serverConfig = createServerConfig();
      mockOnboarding.phase = "connected_guided";
      mockOnboarding.isGuidedPostConnect = true;

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("guided-initial-input")).toHaveTextContent(
          "Draw me an MCP architecture diagram",
        );
      });
    });

    it("completes onboarding after the first guided message is sent", async () => {
      const serverConfig = createServerConfig();
      mockOnboarding.phase = "connected_guided";
      mockOnboarding.isGuidedPostConnect = true;

      render(
        <AppBuilderTab serverConfig={serverConfig} serverName="test-server" />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("first-message-sent")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("first-message-sent"));

      expect(mockOnboarding.completeOnboarding).toHaveBeenCalledTimes(1);
    });

    it("restores sidebars and reports no onboarding when unmounted", () => {
      const onOnboardingChange = vi.fn();

      const { unmount } = render(
        <AppBuilderTab onOnboardingChange={onOnboardingChange} />,
      );

      expect(onOnboardingChange).toHaveBeenCalledWith(false);
      expect(mockUIPlaygroundStore.setSidebarVisible).toHaveBeenCalledWith(true);
      expect(mockSetMcpSidebarOpen).toHaveBeenCalledWith(true);

      unmount();

      expect(onOnboardingChange).toHaveBeenLastCalledWith(false);
      expect(mockUIPlaygroundStore.setSidebarVisible).toHaveBeenLastCalledWith(
        true,
      );
      expect(mockSetMcpSidebarOpen).toHaveBeenLastCalledWith(true);
    });

    it("shows empty state when onboarding is dismissed and no server", () => {
      mockOnboarding.phase = "dismissed";
      mockOnboarding.isOverlayVisible = false;

      render(<AppBuilderTab />);

      expect(screen.getByText("No Server Selected")).toBeInTheDocument();
    });
  });

  describe("server change", () => {
    it("refetches tools when serverName changes", async () => {
      const serverConfig = createServerConfig();

      const { rerender } = render(
        <AppBuilderTab serverConfig={serverConfig} serverName="server-1" />,
      );

      await waitFor(() => {
        expect(mockListTools).toHaveBeenCalledWith({
          serverId: "server-1",
        });
      });

      rerender(
        <AppBuilderTab serverConfig={serverConfig} serverName="server-2" />,
      );

      await waitFor(() => {
        expect(mockListTools).toHaveBeenCalledWith({
          serverId: "server-2",
        });
      });
    });

    it("resets state when server becomes undefined", async () => {
      const serverConfig = createServerConfig();

      const { rerender } = render(
        <AppBuilderTab serverConfig={serverConfig} serverName="server-1" />,
      );

      await waitFor(() => {
        expect(mockListTools).toHaveBeenCalled();
      });

      rerender(
        <AppBuilderTab serverConfig={undefined} serverName={undefined} />,
      );

      expect(screen.getByText("No Server Selected")).toBeInTheDocument();
    });
  });
});
