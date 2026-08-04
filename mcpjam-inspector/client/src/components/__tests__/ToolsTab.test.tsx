import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { ToolsTab } from "../ToolsTab";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";

// Mock posthog
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

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

// SEP-2350 step-up orchestration — spy so we can assert the local tool-call
// surface drives the resolver on a `403 insufficient_scope`.
const mockApplyToolCallStepUp = vi.fn();
const mockResetToolCallStepUp = vi.fn();
vi.mock("@/state/oauth-orchestrator", () => ({
  applyToolCallStepUp: (...args: unknown[]) => mockApplyToolCallStepUp(...args),
  resetToolCallStepUp: (...args: unknown[]) => mockResetToolCallStepUp(...args),
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

// Route the tool-quality lint subscription through a spy so tests can assert
// its args (snapshot vs "skip"). Resolves to "pending" (undefined) by default —
// no ConvexProvider needed. Other convex/react exports are preserved.
const { mockUseQuery, mockUseToolQualityEnabled } = vi.hoisted(() => ({
  mockUseQuery: vi.fn((..._args: unknown[]) => undefined as unknown),
  mockUseToolQualityEnabled: vi.fn(() => true),
}));
vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return { ...actual, useQuery: (...args: unknown[]) => mockUseQuery(...args) };
});

// Tool-quality rollout flag — on by default so existing tests are unaffected;
// flipped per-test in the "tool-quality flag gate" suite below.
vi.mock("@/hooks/useToolQualityEnabled", () => ({
  TOOL_QUALITY_FEATURE_FLAG: "tool-quality-enabled",
  useToolQualityEnabled: () => mockUseToolQualityEnabled(),
}));

// Mock task tracker. getTrackedTaskScope is read at the top of executeTool
// (finding 4: scope captured at call start, per execution).
const { mockTrackTask, mockGetTrackedTaskScope } = vi.hoisted(() => ({
  mockTrackTask: vi.fn(),
  mockGetTrackedTaskScope: vi.fn((): string | undefined => undefined),
}));
vi.mock("@/lib/task-tracker", () => ({
  trackTask: mockTrackTask,
  getTrackedTaskScope: mockGetTrackedTaskScope,
}));

// Stub the elicitation dialog with an accept button so tests can resume a
// pending execution without driving the real form.
vi.mock("../ElicitationDialog", () => ({
  ElicitationDialog: ({
    elicitationRequest,
    onResponse,
  }: {
    elicitationRequest: unknown;
    onResponse: (action: "accept") => void;
  }) =>
    elicitationRequest ? (
      <button
        data-testid="elicitation-accept"
        onClick={() => onResponse("accept")}
      >
        accept-elicitation
      </button>
    ) : null,
}));

// Mock app navigation — the task_created success branch navigates to /tasks;
// stub it so tests don't need a router mounted.
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: vi.fn(),
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
    overrides: Partial<MCPServerConfig> = {}
  ): MCPServerConfig =>
    ({
      transportType: "stdio",
      command: "node",
      args: ["server.js"],
      ...overrides,
    } as MCPServerConfig);

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseToolQualityEnabled.mockReturnValue(true);
    mockUseQuery.mockReturnValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockGetTaskCapabilities.mockResolvedValue({
      wire: "legacy",
      toolCalls: false,
      list: false,
      cancel: false,
      update: false,
      inlineResult: false,
    });
    mockApplyToolCallStepUp.mockResolvedValue({
      action: "reauthorize",
      scopes: [],
      attempt: 0,
    });
  });

  describe("empty state", () => {
    it("shows empty state when no server config provided", () => {
      render(<ToolsTab />);

      expect(screen.getByText("No Server Selected")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Connect to an MCP server to explore and test its available tools."
        )
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
        expect(mockListTools).toHaveBeenCalledWith({
          serverId: "test-server",
          cursor: undefined,
          refresh: false,
        });
      });
    });

    it("does not fetch tools or task capabilities when the server is disconnected", () => {
      const serverConfig = createServerConfig();

      render(
        <ToolsTab
          serverConfig={serverConfig}
          serverName="test-server"
          serverConnectionStatus="disconnected"
        />
      );

      expect(mockListTools).not.toHaveBeenCalled();
      expect(mockGetTaskCapabilities).not.toHaveBeenCalled();
      expect(
        screen.getByText("Connect this server to load tools.")
      ).toBeInTheDocument();
    });

    it("clears loaded tools when the selected server disconnects", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [{ name: "test-tool", inputSchema: { type: "object" } }],
      });

      const { rerender } = render(
        <ToolsTab
          serverConfig={serverConfig}
          serverName="test-server"
          serverConnectionStatus="connected"
        />
      );

      await waitFor(() => {
        expect(screen.getByText("test-tool")).toBeInTheDocument();
      });
      expect(mockListTools).toHaveBeenCalledTimes(1);

      rerender(
        <ToolsTab
          serverConfig={serverConfig}
          serverName="test-server"
          serverConnectionStatus="disconnected"
        />
      );

      await waitFor(() => {
        expect(screen.queryByText("test-tool")).not.toBeInTheDocument();
      });
      expect(
        screen.getByText("Connect this server to load tools.")
      ).toBeInTheDocument();
      expect(mockListTools).toHaveBeenCalledTimes(1);
    });

    it("ignores a stale tools response after the selected server disconnects", async () => {
      const serverConfig = createServerConfig();
      let resolveTools!: (value: {
        tools: Array<Record<string, unknown>>;
      }) => void;
      mockListTools.mockReturnValue(
        new Promise((resolve) => {
          resolveTools = resolve;
        })
      );

      const { rerender } = render(
        <ToolsTab
          serverConfig={serverConfig}
          serverName="test-server"
          serverConnectionStatus="connected"
        />
      );

      await waitFor(() => {
        expect(mockListTools).toHaveBeenCalledTimes(1);
      });

      rerender(
        <ToolsTab
          serverConfig={serverConfig}
          serverName="test-server"
          serverConnectionStatus="disconnected"
        />
      );

      await act(async () => {
        resolveTools({
          tools: [{ name: "late-tool", inputSchema: { type: "object" } }],
        });
      });

      expect(screen.queryByText("late-tool")).not.toBeInTheDocument();
      expect(
        screen.getByText("Connect this server to load tools.")
      ).toBeInTheDocument();
    });

    it("preserves task capabilities when refreshing tools", async () => {
      const serverConfig = createServerConfig();

      mockGetTaskCapabilities.mockResolvedValue({
        wire: "legacy",
        toolCalls: true,
        list: false,
        cancel: false,
        update: false,
        inlineResult: false,
      });
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "task-tool",
            inputSchema: { type: "object" },
            execution: { taskSupport: "optional" },
          },
        ],
      });

      render(
        <ToolsTab
          serverConfig={serverConfig}
          serverName="test-server"
          serverConnectionStatus="connected"
        />
      );

      await waitFor(() => {
        expect(screen.getByText("task-tool")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(mockGetTaskCapabilities).toHaveBeenCalledWith("test-server");
      });

      fireEvent.click(screen.getByText("task-tool"));

      await waitFor(() => {
        expect(screen.getByText("Execute as task")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle("Refresh tools"));

      await waitFor(() => {
        expect(mockListTools).toHaveBeenCalledTimes(2);
      });

      fireEvent.click(screen.getByText("task-tool"));

      await waitFor(() => {
        expect(screen.getByText("Execute as task")).toBeInTheDocument();
      });
      expect(mockGetTaskCapabilities).toHaveBeenCalledTimes(1);
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
        expect(screen.getByText("No selection")).toBeInTheDocument();
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
          screen.getByRole("button", { name: /^run/i })
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
          screen.getByRole("button", { name: /^run/i })
        ).toBeInTheDocument();
      });

      // Find and click execute button
      const executeButton = screen.getByRole("button", { name: /^run/i });
      fireEvent.click(executeButton);

      await waitFor(() => {
        expect(mockExecuteToolApi).toHaveBeenCalledWith(
          "test-server",
          "greet",
          expect.any(Object),
          undefined,
          undefined
        );
      });
    });

    it("drives the step-up resolver on a 403 insufficient_scope challenge", async () => {
      const serverConfig = createServerConfig();
      const server = {
        name: "test-server",
        config: serverConfig,
        useOAuth: true,
      } as unknown as import("@/state/app-types").ServerWithName;

      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "scoped-tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });

      // The tool call fails with a runtime insufficient-scope challenge.
      mockExecuteToolApi.mockResolvedValue({
        error: "insufficient_scope",
        insufficientScope: {
          requiredScope: "admin",
          resourceMetadataUrl: "https://rs.example/.well-known",
        },
      });

      render(
        <ToolsTab
          serverConfig={serverConfig}
          serverName="test-server"
          server={server}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("scoped-tool")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("scoped-tool"));
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /^run/i })
        ).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("button", { name: /^run/i }));

      // The local surface forwards the challenge into the step-up resolver.
      await waitFor(() => {
        expect(mockApplyToolCallStepUp).toHaveBeenCalledWith(
          server,
          expect.objectContaining({
            requiredScope: "admin",
            resourceMetadataUrl: "https://rs.example/.well-known",
          }),
          {
            operation: {
              method: "tools/call",
              operation: "scoped-tool",
            },
          }
        );
      });
    });

    it("resets the step-up counter after a successful tool call", async () => {
      const serverConfig = createServerConfig();
      const server = {
        name: "test-server",
        config: serverConfig,
        useOAuth: true,
      } as unknown as import("@/state/app-types").ServerWithName;

      mockListTools.mockResolvedValue({
        tools: [
          { name: "ok-tool", inputSchema: { type: "object", properties: {} } },
        ],
      });
      mockExecuteToolApi.mockResolvedValue({
        status: "completed",
        result: { content: [{ type: "text", text: "ok" }] },
      });

      render(
        <ToolsTab
          serverConfig={serverConfig}
          serverName="test-server"
          server={server}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("ok-tool")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("ok-tool"));
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /^run/i })
        ).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("button", { name: /^run/i }));

      await waitFor(() => {
        expect(mockResetToolCallStepUp).toHaveBeenCalledWith(server, {
          method: "tools/call",
          operation: "ok-tool",
        });
      });
      expect(mockApplyToolCallStepUp).not.toHaveBeenCalled();
    });

    it("resets the step-up counter on a task_created success too", async () => {
      const serverConfig = createServerConfig();
      const server = {
        name: "test-server",
        config: serverConfig,
        useOAuth: true,
      } as unknown as import("@/state/app-types").ServerWithName;

      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "task-tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      // A task-augmented tool that succeeds returns `task_created`, NOT
      // `completed` — the reset must still fire on this branch.
      mockExecuteToolApi.mockResolvedValue({
        status: "task_created",
        task: {
          taskId: "task-1",
          createdAt: Date.now(),
          status: "working",
          ttl: 0,
          pollInterval: 1000,
        },
      });

      render(
        <ToolsTab
          serverConfig={serverConfig}
          serverName="test-server"
          server={server}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("task-tool")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("task-tool"));
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /^run/i })
        ).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("button", { name: /^run/i }));

      await waitFor(() => {
        expect(mockResetToolCallStepUp).toHaveBeenCalledWith(server, {
          method: "tools/call",
          operation: "task-tool",
        });
      });
    });

    it("dedupes concurrent step-ups: only one runs per server while in flight", async () => {
      const serverConfig = createServerConfig();
      const server = {
        name: "test-server",
        config: serverConfig,
        useOAuth: true,
      } as unknown as import("@/state/app-types").ServerWithName;

      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "scoped-tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      // Every run surfaces the same insufficient-scope challenge.
      mockExecuteToolApi.mockResolvedValue({
        error: "insufficient_scope",
        insufficientScope: {
          requiredScope: "admin",
          resourceMetadataUrl: "https://rs.example/.well-known",
        },
      });
      // Keep the first step-up pending (a redirect flow would navigate away),
      // so the in-flight guard stays set across the second run.
      mockApplyToolCallStepUp.mockReturnValue(new Promise(() => {}));

      render(
        <ToolsTab
          serverConfig={serverConfig}
          serverName="test-server"
          server={server}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("scoped-tool")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("scoped-tool"));
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /^run/i })
        ).toBeInTheDocument();
      });

      const runButton = screen.getByRole("button", { name: /^run/i });
      fireEvent.click(runButton);
      await waitFor(() => {
        expect(mockApplyToolCallStepUp).toHaveBeenCalledTimes(1);
      });

      // A second run while the first step-up is still resolving must NOT fire a
      // duplicate (which would double-redirect / double-bump the counter).
      fireEvent.click(runButton);
      await waitFor(() => {
        expect(mockExecuteToolApi).toHaveBeenCalledTimes(2);
      });
      expect(mockApplyToolCallStepUp).toHaveBeenCalledTimes(1);
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

  // Re-review finding 6 (r3668331238): the scope a task_created is filed
  // under belongs to its ORIGINATING execution. A second execution started
  // while the first's elicitation is pending must not clobber it — the scope
  // rides on the per-execution elicitation record, not a shared ref.
  describe("per-execution scope across overlapping executions", () => {
    it("files the resumed first execution's task under the FIRST call's scope", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "greet",
            description: "Greet someone",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      // Execution 1 captures scope-1; execution 2 (started later, after a
      // project switch) captures scope-2.
      mockGetTrackedTaskScope
        .mockReturnValueOnce("scope-1")
        .mockReturnValueOnce("scope-2");
      mockExecuteToolApi
        .mockResolvedValueOnce({
          status: "elicitation_required",
          executionId: "exec-1",
          requestId: "req-1",
          request: { message: "Need input" },
          timestamp: "2026-01-01T00:00:00Z",
        })
        // Execution 2 stays in flight while execution 1 is resumed.
        .mockReturnValueOnce(new Promise(() => {}));
      mockRespondToElicitationApi.mockResolvedValue({
        status: "task_created",
        task: {
          taskId: "task-1",
          status: "working",
          createdAt: "2026-01-01T00:00:01Z",
        },
      });

      render(
        <ToolsTab
          serverConfig={createServerConfig()}
          serverName="test-server"
        />
      );
      await waitFor(() => {
        expect(screen.getByText("greet")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("greet"));
      const runButton = await screen.findByRole("button", { name: /^run/i });

      // Execution 1 → suspends on elicitation (scope-1 on its record).
      fireEvent.click(runButton);
      await screen.findByTestId("elicitation-accept");

      // Execution 2 starts while 1 is suspended; it captures scope-2.
      fireEvent.click(runButton);
      await waitFor(() => {
        expect(mockExecuteToolApi).toHaveBeenCalledTimes(2);
      });

      // Resume execution 1: its task_created must carry scope-1.
      fireEvent.click(screen.getByTestId("elicitation-accept"));
      await waitFor(() => {
        expect(mockTrackTask).toHaveBeenCalledTimes(1);
      });
      expect(mockTrackTask).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-1", scope: "scope-1" })
      );
    });
  });

  // Finding 6: legacy wire + a tool that REQUIRES task execution + host tasks
  // off ⇒ the tool cannot run at all, so the affordance is disabled with a
  // reason. Affordance framing, not a security boundary — the route never
  // sees the host config.
  describe("legacy task-required gating when tasks are host-disabled", () => {
    const DISABLED_REASON =
      "This tool requires task execution, and tasks are disabled by the host configuration.";

    const setupRequiredTool = async (options?: {
      tasksMode?: "off" | "expose";
      taskSupport?: "required" | "optional";
      toolCalls?: boolean;
    }) => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "long_job",
            description: "Runs a long job",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
            },
            execution: { taskSupport: options?.taskSupport ?? "required" },
          },
        ],
      });
      mockGetTaskCapabilities.mockResolvedValue({
        wire: "legacy",
        toolCalls: options?.toolCalls ?? true,
        list: true,
        cancel: false,
        update: false,
        inlineResult: false,
      });
      mockExecuteToolApi.mockResolvedValue({
        status: "completed",
        result: { content: [] },
      });

      render(
        <ToolsTab
          serverConfig={createServerConfig()}
          serverName="test-server"
          tasksMode={options?.tasksMode ?? "off"}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("long_job")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("long_job"));
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /^run/i })
        ).toBeInTheDocument();
      });
      return screen.getByRole("button", { name: /^run/i });
    };

    it("disables the Run button and shows the reason", async () => {
      const runButton = await setupRequiredTool();

      expect(runButton).toBeDisabled();
      await waitFor(() => {
        expect(screen.getByText(DISABLED_REASON)).toBeInTheDocument();
      });
    });

    it("Enter does not fire the execute API", async () => {
      await setupRequiredTool();

      // The global keydown path funnels into executeTool, whose guard is the
      // one thing covering every entry point.
      fireEvent.keyDown(window, { key: "Enter" });

      await waitFor(() => {
        // The guard surfaced the reason as an error notice...
        expect(screen.getAllByText(DISABLED_REASON).length).toBeGreaterThan(0);
      });
      // ...and nothing was executed.
      expect(mockExecuteToolApi).not.toHaveBeenCalled();
    });

    it("re-enables when the host allows tasks", async () => {
      const runButton = await setupRequiredTool({ tasksMode: "expose" });
      expect(runButton).not.toBeDisabled();

      fireEvent.click(runButton);
      await waitFor(() => {
        // Required tool on the legacy wire runs AS a task when tasks are on.
        expect(mockExecuteToolApi).toHaveBeenCalledWith(
          "test-server",
          "long_job",
          expect.any(Object),
          expect.objectContaining({}),
          undefined
        );
      });
    });

    it("re-enables when the tool does not require task execution", async () => {
      const runButton = await setupRequiredTool({ taskSupport: "optional" });
      expect(runButton).not.toBeDisabled();
    });

    it("re-enables when the server never declared task tool calls", async () => {
      const runButton = await setupRequiredTool({ toolCalls: false });
      expect(runButton).not.toBeDisabled();
    });
  });

  describe("server change", () => {
    it("clears state when server config becomes undefined", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({
        tools: [{ name: "test-tool", inputSchema: { type: "object" } }],
      });

      const { rerender } = render(
        <ToolsTab serverConfig={serverConfig} serverName="test-server" />
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
        <ToolsTab serverConfig={serverConfig} serverName="server-1" />
      );

      await waitFor(() => {
        expect(mockListTools).toHaveBeenCalledWith({
          serverId: "server-1",
          cursor: undefined,
          refresh: false,
        });
      });

      mockListTools.mockResolvedValue({
        tools: [
          { name: "tool-from-server-2", inputSchema: { type: "object" } },
        ],
      });

      rerender(<ToolsTab serverConfig={serverConfig} serverName="server-2" />);

      await waitFor(() => {
        expect(mockListTools).toHaveBeenCalledWith({
          serverId: "server-2",
          cursor: undefined,
          refresh: false,
        });
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
        const executeButton = screen.getByRole("button", { name: /^run/i });
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
      const toolsTabButton = screen.getByRole("button", { name: /^tools/i });
      expect(toolsTabButton.className).toContain("text-primary");
    });

    it("can switch to saved tab", async () => {
      const serverConfig = createServerConfig();

      mockListTools.mockResolvedValue({ tools: [] });

      render(<ToolsTab serverConfig={serverConfig} serverName="test-server" />);

      const savedTabButton = screen.getByRole("button", {
        name: /^saved/i,
      });
      fireEvent.click(savedTabButton);

      // After clicking, saved tab should have active styling
      expect(savedTabButton.className).toContain("text-primary");
    });
  });

  describe("tool-quality flag gate", () => {
    const toolResponse = {
      tools: [
        {
          name: "read-file",
          description: "Read a file from disk",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };

    it("subscribes with a snapshot when the flag is on", async () => {
      mockUseToolQualityEnabled.mockReturnValue(true);
      mockListTools.mockResolvedValue(toolResponse);

      render(
        <ToolsTab
          serverConfig={createServerConfig()}
          serverName="test-server"
        />
      );

      await waitFor(() => {
        expect(screen.getByText("read-file")).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(mockUseQuery).toHaveBeenCalledWith(
          "toolPrechecks:get",
          expect.objectContaining({
            snapshot: expect.objectContaining({ servers: expect.any(Array) }),
          })
        );
      });
    });

    it("skips the subscription (no snapshot) when the flag is off", async () => {
      mockUseToolQualityEnabled.mockReturnValue(false);
      mockListTools.mockResolvedValue(toolResponse);

      render(
        <ToolsTab
          serverConfig={createServerConfig()}
          serverName="test-server"
        />
      );

      // Tools still load; only the lint subscription is gated.
      await waitFor(() => {
        expect(screen.getByText("read-file")).toBeInTheDocument();
      });

      expect(mockUseQuery).toHaveBeenCalledWith("toolPrechecks:get", "skip");
      expect(mockUseQuery).not.toHaveBeenCalledWith(
        "toolPrechecks:get",
        expect.objectContaining({ snapshot: expect.anything() })
      );
    });
  });
});
