import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { AppBuilderTab } from "../AppBuilderTab";

const mockListTools = vi.fn();

const mockPreferencesState = {
  hostStyle: "claude",
};

const mockUIPlaygroundStore = {
  selectedTool: null,
  tools: {},
  formFields: [],
  isExecuting: false,
  deviceType: "mobile",
  isSidebarVisible: true,
  selectedProtocol: null,
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
  toggleSidebar: vi.fn(),
  setSelectedProtocol: vi.fn(),
  reset: vi.fn(),
  setSidebarVisible: vi.fn(),
};

const mockOnboarding = {
  phase: "dismissed" as string,
  isGuidedPostConnect: false,
  isResolvingRemoteCompletion: false,
  isBootstrappingFirstRunConnection: false,
  connectExcalidraw: vi.fn(),
  completeOnboarding: vi.fn(),
  connectError: null as string | null,
  retryConnect: vi.fn(),
};

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    dismiss: vi.fn(),
  },
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn().mockReturnValue("test"),
  detectPlatform: vi.fn().mockReturnValue("web"),
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: (...args: unknown[]) => mockListTools(...args),
}));

vi.mock("@/lib/tool-form", () => ({
  generateFormFieldsFromSchema: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  detectUiTypeFromTool: vi.fn().mockReturnValue(null),
  UIType: {
    OPENAI_SDK: "openai-apps",
    MCP_APPS: "mcp-apps",
    OPENAI_SDK_AND_MCP_APPS: "both",
  },
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (
    selector: (state: typeof mockPreferencesState) => unknown,
  ) => selector(mockPreferencesState),
}));

vi.mock("@/stores/ui-playground-store", () => ({
  useUIPlaygroundStore: () => mockUIPlaygroundStore,
}));

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

vi.mock("../../ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

vi.mock("../PlaygroundLeft", () => ({
  PlaygroundLeft: () => <div data-testid="playground-left" />,
}));

vi.mock("../PlaygroundMain", () => ({
  PlaygroundMain: () => <div data-testid="playground-main" />,
}));

vi.mock("../../tools/SaveRequestDialog", () => ({
  default: () => null,
}));

vi.mock("../../app-builder/AppBuilderSkeleton", () => ({
  AppBuilderSkeleton: () => <div data-testid="app-builder-skeleton" />,
}));

vi.mock("../../ui/collapsed-panel-strip", () => ({
  CollapsedPanelStrip: () => <div data-testid="collapsed-panel-strip" />,
}));

vi.mock("@/hooks/use-onboarding", () => ({
  useOnboarding: () => mockOnboarding,
}));

vi.mock("framer-motion", () => ({
  motion: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => (
      <div {...props}>{children}</div>
    ),
  },
  useReducedMotion: () => false,
}));

function ShellSidebarHarness() {
  const { open, setOpen } = useSidebar();

  return (
    <>
      <span data-testid="shell-sidebar-state">{open ? "open" : "closed"}</span>
      <button
        type="button"
        aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
        onClick={() => setOpen((value) => !value)}
      >
        Toggle shell sidebar
      </button>
    </>
  );
}

function createServerConfig(): MCPServerConfig {
  return {
    transportType: "stdio",
    command: "node",
    args: ["server.js"],
  } as MCPServerConfig;
}

function connectedServer(name: string) {
  return {
    [name]: {
      name,
      config: createServerConfig(),
      connectionStatus: "connected" as const,
      lastConnectionTime: new Date(),
      retryCount: 0,
    },
  };
}

describe("AppBuilderTab shell sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue({ tools: [], toolsMetadata: {} });

    Object.assign(mockUIPlaygroundStore, {
      selectedTool: null,
      tools: {},
      formFields: [],
      isExecuting: false,
      deviceType: "mobile",
      isSidebarVisible: true,
      selectedProtocol: null,
    });

    Object.assign(mockOnboarding, {
      phase: "dismissed",
      isGuidedPostConnect: false,
      isResolvingRemoteCompletion: false,
      isBootstrappingFirstRunConnection: false,
      connectError: null,
    });
  });

  it("keeps the shell sidebar collapsed after toggling it in App Builder", async () => {
    render(
      <SidebarProvider defaultOpen={true}>
        <ShellSidebarHarness />
        <AppBuilderTab
          serverConfig={createServerConfig()}
          serverName="test-server"
          servers={connectedServer("test-server")}
        />
      </SidebarProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("shell-sidebar-state")).toHaveTextContent(
        "open",
      );
    });

    fireEvent.click(
      screen.getByRole("button", { name: /collapse sidebar/i }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("shell-sidebar-state")).toHaveTextContent(
        "closed",
      );
      expect(
        screen.getByRole("button", { name: /expand sidebar/i }),
      ).toBeInTheDocument();
    });
  });
});
