import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToolsTab } from "../ToolsTab";
import { useAuthChallengeCardStore } from "@/lib/auth-challenge-lifecycle";
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

// The real orchestrator and lifecycle run; only the OAuth state machine and
// the reset spies are stubbed, so the test sees exactly what a click starts.
const { initiateOAuthMock, mockResetToolCallStepUp, mockResetAuthChallenge } =
  vi.hoisted(() => ({
    initiateOAuthMock: vi.fn(),
    mockResetToolCallStepUp: vi.fn(),
    mockResetAuthChallenge: vi.fn(),
  }));
const readStoredDiscoveryScopesMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/oauth/mcp-oauth", () => ({
  clearOAuthData: vi.fn(),
  clearOAuthFlowState: vi.fn(),
  hasOAuthConfig: vi.fn(),
  initiateOAuth: initiateOAuthMock,
  readStoredDiscoveryScopes: readStoredDiscoveryScopesMock,
  readStoredOAuthConfig: vi.fn(() => ({})),
  resolveStoredIssuer: vi.fn(() => "https://as.example"),
}));
vi.mock("@/state/oauth-orchestrator", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/state/oauth-orchestrator")>();
  return {
    ...actual,
    resetToolCallStepUp: (...args: unknown[]) =>
      mockResetToolCallStepUp(...args),
    resetAuthChallenge: (...args: unknown[]) => mockResetAuthChallenge(...args),
  };
});

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

const PRM = "https://orders.example/.well-known/oauth-protected-resource/mcp";

const serverConfig = {
  type: "http",
  url: "https://orders.example/mcp",
} as unknown as MCPServerConfig;
const server = {
  name: "orders",
  config: serverConfig,
  useOAuth: false,
} as unknown as import("@/state/app-types").ServerWithName;

function signal(overrides: Record<string, unknown> = {}) {
  return {
    source: "http_401",
    requiredScope: "orders:read",
    resourceMetadataUrl: PRM,
    effectiveAuth: "discover",
    facets: {
      challengeHeader: "bearer",
      hasResourceMetadata: true,
      hasScope: true,
      hasErrorParams: false,
    },
    ...overrides,
  };
}

async function runTool(name: string, readOnlyHint = true) {
  mockListTools.mockResolvedValue({
    tools: [
      {
        name,
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint },
      },
    ],
  });
  render(
    <ToolsTab
      serverConfig={serverConfig}
      serverName="orders"
      server={server}
    />,
  );
  await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument());
  fireEvent.click(screen.getByText(name));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^run/i })).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: /^run/i }));
}

describe("ToolsTab mid-session sign-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    useAuthChallengeCardStore.setState({ cards: {} });
    mockUseToolQualityEnabled.mockReturnValue(true);
    mockUseQuery.mockReturnValue(undefined);
    mockGetTaskCapabilities.mockResolvedValue({
      wire: "legacy",
      toolCalls: false,
      list: false,
      cancel: false,
      update: false,
      inlineResult: false,
    });
    initiateOAuthMock.mockResolvedValue({ success: true });
  });

  it("shows a Connect card for a 401 challenge, and a scripted click does not sign in", async () => {
    mockExecuteToolApi.mockResolvedValue({
      error: "Sign in required",
      status: 401,
      authChallenge: signal(),
    });
    await runTool("list_orders");

    const card = await screen.findByTestId("auth-challenge-card");
    expect(card).toHaveTextContent(
      "orders (https://orders.example) needs you to sign in to use list_orders.",
    );
    // fireEvent dispatches an untrusted event, like a script would.
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(screen.getByTestId("auth-challenge-notice")).toHaveTextContent(
        "Click Connect to sign in.",
      ),
    );
    expect(initiateOAuthMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("mcp-scope-step-up-replay-v1")).toBeNull();
  });

  it("explains instead of prompting when the server's auth method cannot sign in", async () => {
    mockExecuteToolApi.mockResolvedValue({
      error: "Sign in required",
      status: 401,
      authChallenge: signal({ effectiveAuth: "xaa" }),
    });
    await runTool("list_orders");
    await waitFor(() =>
      expect(screen.getByTestId("auth-challenge-notice")).toHaveTextContent(
        /Cross-App Access/,
      ),
    );
    expect(screen.queryByTestId("auth-challenge-card")).toBeNull();
  });

  it("does not count a _meta-challenged result as a success", async () => {
    mockExecuteToolApi.mockResolvedValue({
      status: "completed",
      result: {
        isError: true,
        content: [{ type: "text", text: "Sign in" }],
      },
      authChallenge: signal({
        source: "tool_result_meta",
        error: "insufficient_scope",
        errorDescription: "You need to login to continue",
        facets: {
          challengeHeader: "bearer",
          hasResourceMetadata: true,
          hasScope: false,
          hasErrorParams: true,
        },
      }),
      toolSecuritySchemes: { schemes: [{ type: "oauth2" }], source: "tool" },
    });
    await runTool("list_orders");
    // Spec default: the `_meta` challenge passes through, with the reason.
    await waitFor(() =>
      expect(screen.getByTestId("auth-challenge-notice")).toHaveTextContent(
        /ignores _meta/,
      ),
    );
    expect(mockResetToolCallStepUp).not.toHaveBeenCalled();
    expect(mockResetAuthChallenge).not.toHaveBeenCalled();
  });

  it("resets both budgets after an ordinary success", async () => {
    mockExecuteToolApi.mockResolvedValue({
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }] },
    });
    await runTool("list_orders");
    await waitFor(() =>
      expect(mockResetAuthChallenge).toHaveBeenCalledWith(server, {
        method: "tools/call",
        operation: "list_orders",
      }),
    );
    expect(mockResetToolCallStepUp).toHaveBeenCalled();
  });

  it("asks before re-running a write tool after sign-in", async () => {
    sessionStorage.setItem(
      "mcp-scope-step-up-replay-v1",
      JSON.stringify({
        version: 1,
        phase: "ready",
        operation: {
          resourceUrl: "https://orders.example/mcp",
          method: "tools/call",
          operation: "cancel_order",
        },
        descriptor: {
          kind: "tool",
          surface: "tools",
          serverName: "orders",
          toolName: "cancel_order",
          parameters: { id: "42" },
        },
        returnPath: "/",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        reason: "authorization_required",
        requiresConfirmation: true,
      }),
    );
    mockListTools.mockResolvedValue({ tools: [] });
    mockExecuteToolApi.mockResolvedValue({
      status: "completed",
      result: { content: [{ type: "text", text: "cancelled" }] },
    });
    render(
      <ToolsTab
        serverConfig={serverConfig}
        serverName="orders"
        server={server}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText("Signed in. Run cancel_order again?"),
      ).toBeInTheDocument(),
    );
    expect(mockExecuteToolApi).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    await waitFor(() =>
      expect(mockExecuteToolApi).toHaveBeenCalledWith(
        "orders",
        "cancel_order",
        { id: "42" },
        undefined,
        undefined,
      ),
    );
  });
});
