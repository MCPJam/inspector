import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxChatPage } from "../SandboxChatPage";
import {
  SANDBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY,
  clearSandboxSession,
  writeSandboxSession,
} from "@/lib/sandbox-session";
import {
  clearHostedOAuthResumeMarker,
  writeHostedOAuthResumeMarker,
} from "@/lib/hosted-oauth-resume";

const {
  mockConvexAuthState,
  mockGetAccessToken,
  mockSignIn,
  mockGetStoredTokens,
  mockInitiateOAuth,
  mockValidateHostedServer,
  mockChatTabV2,
} = vi.hoisted(() => ({
  mockConvexAuthState: {
    isAuthenticated: true,
    isLoading: false,
  },
  mockGetAccessToken: vi.fn(),
  mockSignIn: vi.fn(),
  mockGetStoredTokens: vi.fn(),
  mockInitiateOAuth: vi.fn(async () => ({ success: false })),
  mockValidateHostedServer: vi.fn(),
  mockChatTabV2: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockConvexAuthState,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: mockGetAccessToken,
    signIn: mockSignIn,
  }),
}));

vi.mock("@/hooks/hosted/use-hosted-api-context", () => ({
  useHostedApiContext: vi.fn(),
}));

vi.mock("@/lib/apis/web/servers-api", () => ({
  validateHostedServer: mockValidateHostedServer,
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: "light" }) => unknown) =>
    selector({ themeMode: "light" }),
}));

vi.mock("@/components/ChatTabV2", () => ({
  ChatTabV2: (props: {
    onOAuthRequired?: (details?: {
      serverUrl?: string | null;
      serverId?: string | null;
      serverName?: string | null;
    }) => void;
    reasoningDisplayMode?: string;
  }) => {
    mockChatTabV2(props);
    const { onOAuthRequired } = props;
    return (
      <div>
        <div data-testid="sandbox-chat-tab" />
        {onOAuthRequired ? (
          <>
            <button type="button" onClick={() => onOAuthRequired()}>
              Trigger OAuth
            </button>
            <button
              type="button"
              onClick={() =>
                onOAuthRequired({
                  serverId: "srv_asana",
                  serverName: "asana",
                  serverUrl: "https://mcp.asana.com/sse",
                })
              }
            >
              Trigger targeted OAuth
            </button>
          </>
        ) : null}
      </div>
    );
  },
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  getStoredTokens: mockGetStoredTokens,
  initiateOAuth: mockInitiateOAuth,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("SandboxChatPage", () => {
  function createFetchResponse(
    body: unknown,
    overrides: Partial<{
      ok: boolean;
      status: number;
      statusText: string;
    }> = {},
  ) {
    return {
      ok: overrides.ok ?? true,
      status: overrides.status ?? 200,
      statusText: overrides.statusText ?? "OK",
      json: async () => body,
      text: async () =>
        typeof body === "string" ? body : JSON.stringify(body),
      headers: new Headers(),
    } as Response;
  }

  beforeEach(() => {
    vi.useRealTimers();
    clearSandboxSession();
    clearHostedOAuthResumeMarker();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    mockConvexAuthState.isAuthenticated = true;
    mockConvexAuthState.isLoading = false;
    mockGetAccessToken.mockReset();
    mockSignIn.mockReset();
    mockGetStoredTokens.mockReset();
    mockInitiateOAuth.mockReset();
    mockValidateHostedServer.mockReset();
    mockChatTabV2.mockReset();

    mockGetAccessToken.mockResolvedValue("workos-token");
    mockGetStoredTokens.mockReturnValue(null);
    mockInitiateOAuth.mockResolvedValue({ success: false });
    mockValidateHostedServer.mockResolvedValue({
      success: true,
      status: "connected",
      initInfo: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("applies sandbox host style data attributes while keeping MCPJam branding", async () => {
    writeSandboxSession({
      token: "sandbox-token",
      payload: {
        workspaceId: "ws_1",
        sandboxId: "sbx_1",
        name: "ChatGPT Sandbox",
        description: "Hosted sandbox",
        hostStyle: "chatgpt",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsWorkspaceMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
    });

    const { container } = render(<SandboxChatPage />);

    expect(await screen.findByTestId("sandbox-chat-tab")).toBeInTheDocument();
    expect(
      container.querySelector('[data-host-style="chatgpt"]'),
    ).toBeInTheDocument();
    expect(screen.getByAltText("MCPJam")).toBeInTheDocument();
    expect(mockChatTabV2).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningDisplayMode: "hidden",
      }),
    );
  });

  it("shows curated copy for an invalid or expired sandbox link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        createFetchResponse(
          {
            code: "NOT_FOUND",
            message:
              "Uncaught Error: This sandbox link is invalid or has expired. at resolveSandboxBootstrapForUser (../../convex/sandboxes.ts:309:14) at async handler (../../convex/sandboxes.ts:1088:6)",
          },
          { ok: false, status: 404, statusText: "Not Found" },
        ),
      ),
    );

    render(<SandboxChatPage pathToken="stale-token" />);

    expect(
      await screen.findByRole("heading", { name: "Sandbox Link Unavailable" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This sandbox link is invalid or expired. Ask the owner to share a new link if you still need access.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Uncaught Error:/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/resolveSandboxBootstrapForUser/),
    ).not.toBeInTheDocument();
  });

  it("keeps the access denied sign-in path intact", async () => {
    mockConvexAuthState.isAuthenticated = false;
    window.history.replaceState({}, "", "/sandbox/test/token-denied");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        createFetchResponse(
          {
            code: "FORBIDDEN",
            message:
              "You don't have access to Test Sandbox. This sandbox is invite-only - ask the owner to invite you.",
          },
          { ok: false, status: 403, statusText: "Forbidden" },
        ),
      ),
    );

    render(<SandboxChatPage pathToken="token-denied" />);

    expect(
      await screen.findByRole("heading", { name: "Access Denied" }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Sign in",
      }),
    );

    expect(mockSignIn).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(SANDBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY)).toBe(
      "/sandbox/test/token-denied",
    );
  });

  it("shows a generic fallback for unexpected sandbox bootstrap failures", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        createFetchResponse(
          {
            code: "INTERNAL_ERROR",
            message:
              "Uncaught Error: Internal database exploded at handler (../../convex/sandboxes.ts:1088:6)",
          },
          { ok: false, status: 500, statusText: "Internal Server Error" },
        ),
      ),
    );

    render(<SandboxChatPage pathToken="broken-token" />);

    expect(
      await screen.findByRole("heading", { name: "Sandbox Link Unavailable" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "We couldn't open this sandbox right now. Please try again or open MCPJam.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Internal database exploded/),
    ).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      "[SandboxChatPage] Failed to bootstrap sandbox",
      expect.objectContaining({
        status: 500,
        code: "INTERNAL_ERROR",
        message: "Internal database exploded",
        rawMessage:
          "Uncaught Error: Internal database exploded at handler (../../convex/sandboxes.ts:1088:6)",
      }),
    );
  });

  it("auto-resumes sandbox OAuth after callback completion", async () => {
    vi.useFakeTimers();
    let hasToken = false;
    mockGetStoredTokens.mockImplementation(() =>
      hasToken ? { access_token: "sandbox-token" } : null,
    );

    writeSandboxSession({
      token: "sandbox-token",
      payload: {
        workspaceId: "ws_1",
        sandboxId: "sbx_1",
        name: "Asana Sandbox",
        description: "Hosted sandbox",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsWorkspaceMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [
          {
            serverId: "srv_asana",
            serverName: "asana",
            useOAuth: true,
            serverUrl: "https://mcp.asana.com/sse",
            clientId: null,
            oauthScopes: null,
          },
        ],
      },
    });
    writeHostedOAuthResumeMarker({
      surface: "sandbox",
      serverName: "Asana Production",
      serverUrl: "https://mcp.asana.com/sse",
    });

    render(<SandboxChatPage />);

    expect(
      screen.getByRole("heading", { name: "Finishing authorization" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Authorize" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      hasToken = true;
      await vi.runAllTimersAsync();
    });

    expect(screen.getByTestId("sandbox-chat-tab")).toBeInTheDocument();
    expect(mockValidateHostedServer).toHaveBeenCalledWith(
      "srv_asana",
      "sandbox-token",
    );
    expect(mockValidateHostedServer).toHaveBeenCalledTimes(1);
  });

  it("shows curated copy instead of transport details when sandbox OAuth validation fails", async () => {
    vi.useFakeTimers();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mockGetStoredTokens.mockReturnValue({ access_token: "stale-token" });
    mockValidateHostedServer.mockRejectedValue(
      new Error(
        'Authentication failed for MCP server "mn70g96re2qn05cxjw7y4y26ah82jzgh": SSE error: SSE error: Non-200 status code (401)',
      ),
    );

    writeSandboxSession({
      token: "sandbox-token",
      payload: {
        workspaceId: "ws_1",
        sandboxId: "sbx_1",
        name: "Asana Sandbox",
        description: "Hosted sandbox",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsWorkspaceMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [
          {
            serverId: "srv_asana",
            serverName: "asana",
            useOAuth: true,
            serverUrl: "https://mcp.asana.com/sse",
            clientId: null,
            oauthScopes: null,
          },
        ],
      },
    });

    render(<SandboxChatPage />);

    expect(
      screen.getByRole("heading", { name: "Finishing authorization" }),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(
      screen.getByRole("heading", { name: "Authorization Required" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your authorization expired or was rejected. Authorize again to continue.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/SSE error/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Non-200 status code/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Authorize again" }),
    ).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      "[useHostedOAuthGate] OAuth validation failed",
      expect.objectContaining({
        surface: "sandbox",
        serverId: "srv_asana",
        serverName: "asana",
      }),
    );
  });

  it("re-enters the sandbox OAuth gate when chat reports OAuth is required", async () => {
    mockGetStoredTokens.mockReturnValue({ access_token: "sandbox-token" });

    writeSandboxSession({
      token: "sandbox-token",
      payload: {
        workspaceId: "ws_1",
        sandboxId: "sbx_1",
        name: "Asana Sandbox",
        description: "Hosted sandbox",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsWorkspaceMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [
          {
            serverId: "srv_asana",
            serverName: "asana",
            useOAuth: true,
            serverUrl: "https://mcp.asana.com/sse",
            clientId: null,
            oauthScopes: null,
          },
        ],
      },
    });

    render(<SandboxChatPage />);

    expect(await screen.findByTestId("sandbox-chat-tab")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Trigger OAuth" }),
    );

    expect(
      screen.getByRole("heading", { name: "Authorization Required" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("You'll return here automatically after consent."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Authorize" }),
    ).toBeInTheDocument();
  });

  it("re-opens auth only for the matching sandbox server when chat includes server details", async () => {
    mockGetStoredTokens.mockImplementation((serverName: string) => {
      if (serverName === "asana") {
        return { access_token: "asana-token" };
      }
      if (serverName === "linear") {
        return { access_token: "linear-token" };
      }
      return null;
    });

    writeSandboxSession({
      token: "sandbox-token",
      payload: {
        workspaceId: "ws_1",
        sandboxId: "sbx_1",
        name: "Asana Sandbox",
        description: "Hosted sandbox",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsWorkspaceMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [
          {
            serverId: "srv_asana",
            serverName: "asana",
            useOAuth: true,
            serverUrl: "https://mcp.asana.com/sse",
            clientId: null,
            oauthScopes: null,
          },
          {
            serverId: "srv_linear",
            serverName: "linear",
            useOAuth: true,
            serverUrl: "https://mcp.linear.app/sse",
            clientId: null,
            oauthScopes: null,
          },
        ],
      },
    });

    render(<SandboxChatPage />);

    expect(await screen.findByTestId("sandbox-chat-tab")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Trigger targeted OAuth" }),
    );

    expect(
      screen.getByRole("heading", { name: "Authorization Required" }),
    ).toBeInTheDocument();
    expect(screen.getByText("asana")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Authorize again" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("linear")).not.toBeInTheDocument();
  });
});
