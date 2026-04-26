import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatboxChatPage } from "../ChatboxChatPage";
import {
  CHATBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY,
  clearChatboxSession,
  writePlaygroundSession,
  writeChatboxSession,
} from "@/lib/chatbox-session";
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
    loadingIndicatorVariant?: string;
  }) => {
    mockChatTabV2(props);
    const { onOAuthRequired } = props;
    return (
      <div>
        <div data-testid="chatbox-chat-tab" />
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

describe("ChatboxChatPage", () => {
  function createFetchResponse(
    body: unknown,
    overrides: Partial<{
      ok: boolean;
      status: number;
      statusText: string;
    }> = {}
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
    clearChatboxSession();
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

  it("applies chatbox host style data attributes while keeping MCPJam branding", async () => {
    writeChatboxSession({
      token: "chatbox-token",
      payload: {
        workspaceId: "ws_1",
        chatboxId: "sbx_1",
        name: "ChatGPT Chatbox",
        description: "Hosted chatbox",
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

    const { container } = render(<ChatboxChatPage />);

    expect(await screen.findByTestId("chatbox-chat-tab")).toBeInTheDocument();
    expect(
      container.querySelector('[data-host-style="chatgpt"]')
    ).toBeInTheDocument();
    expect(screen.getByAltText("MCPJam")).toBeInTheDocument();
    expect(mockChatTabV2).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningDisplayMode: "hidden",
        loadingIndicatorVariant: "chatgpt-dot",
      })
    );
  });

  it("uses the Claude loading indicator variant for Claude-style hosted chatboxes", async () => {
    writeChatboxSession({
      token: "chatbox-token",
      payload: {
        workspaceId: "ws_1",
        chatboxId: "sbx_1",
        name: "Claude Chatbox",
        description: "Hosted chatbox",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsWorkspaceMember: true,
        systemPrompt: "You are helpful.",
        modelId: "anthropic/claude-sonnet-4-5",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
    });

    render(<ChatboxChatPage />);

    expect(await screen.findByTestId("chatbox-chat-tab")).toBeInTheDocument();
    expect(mockChatTabV2).toHaveBeenCalledWith(
      expect.objectContaining({
        loadingIndicatorVariant: "claude-mark",
      })
    );
  });

  it("loads playground sessions from local storage and skips bootstrap", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    window.history.replaceState(
      {},
      "",
      "/chatbox/demo/chatbox-token?playground=1&playgroundId=pg_123"
    );

    writePlaygroundSession({
      playgroundId: "pg_123",
      token: "chatbox-token",
      surface: "preview",
      updatedAt: Date.now(),
      payload: {
        workspaceId: "ws_1",
        chatboxId: "sbx_1",
        name: "Playground Chatbox",
        description: "Hosted chatbox",
        hostStyle: "claude",
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

    render(<ChatboxChatPage pathToken="chatbox-token" />);

    expect(await screen.findByTestId("chatbox-chat-tab")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockChatTabV2).toHaveBeenCalledWith(
      expect.objectContaining({
        hostedContext: expect.objectContaining({
          chatboxSurface: "preview",
        }),
      })
    );
  });

  it("shows a clear error when a playground session has expired", async () => {
    window.history.replaceState(
      {},
      "",
      "/chatbox/demo/chatbox-token?playground=1&playgroundId=missing"
    );

    render(<ChatboxChatPage pathToken="chatbox-token" />);

    expect(
      await screen.findByRole("heading", { name: "Preview unavailable" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Playground session expired. Return to the builder to preview."
      )
    ).toBeInTheDocument();
  });

  it("shows curated copy for an invalid or expired chatbox link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        createFetchResponse(
          {
            code: "NOT_FOUND",
            message:
              "Uncaught Error: This chatbox link is invalid or has expired. at resolveChatboxBootstrapForUser (../../convex/chatboxes.ts:309:14) at async handler (../../convex/chatboxes.ts:1088:6)",
          },
          { ok: false, status: 404, statusText: "Not Found" }
        )
      )
    );

    render(<ChatboxChatPage pathToken="stale-token" />);

    expect(
      await screen.findByRole("heading", { name: "Chatbox Link Unavailable" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This chatbox link is invalid or expired. Ask the owner to share a new link if you still need access."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Uncaught Error:/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/resolveChatboxBootstrapForUser/)
    ).not.toBeInTheDocument();
  });

  it("keeps the access denied sign-in path intact", async () => {
    mockConvexAuthState.isAuthenticated = false;
    window.history.replaceState({}, "", "/chatbox/test/token-denied");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        createFetchResponse(
          {
            code: "FORBIDDEN",
            message:
              "You don't have access to Test Chatbox. This chatbox is invite-only - ask the owner to invite you.",
          },
          { ok: false, status: 403, statusText: "Forbidden" }
        )
      )
    );

    render(<ChatboxChatPage pathToken="token-denied" />);

    expect(
      await screen.findByRole("heading", { name: "Access Denied" })
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Sign in",
      })
    );

    expect(mockSignIn).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(CHATBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY)).toBe(
      "/chatbox/test/token-denied"
    );
  });

  it("shows a generic fallback for unexpected chatbox bootstrap failures", async () => {
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
              "Uncaught Error: Internal database exploded at handler (../../convex/chatboxes.ts:1088:6)",
          },
          { ok: false, status: 500, statusText: "Internal Server Error" }
        )
      )
    );

    render(<ChatboxChatPage pathToken="broken-token" />);

    expect(
      await screen.findByRole("heading", { name: "Chatbox Link Unavailable" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "We couldn't open this chatbox right now. Please try again or open MCPJam."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Internal database exploded/)
    ).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      "[ChatboxChatPage] Failed to bootstrap chatbox",
      expect.objectContaining({
        status: 500,
        code: "INTERNAL_ERROR",
        message: "Internal database exploded",
        rawMessage:
          "Uncaught Error: Internal database exploded at handler (../../convex/chatboxes.ts:1088:6)",
      })
    );
  });

  it("auto-resumes chatbox OAuth after callback completion", async () => {
    vi.useFakeTimers();
    let hasToken = false;
    mockGetStoredTokens.mockImplementation(() =>
      hasToken ? { access_token: "chatbox-token" } : null
    );

    writeChatboxSession({
      token: "chatbox-token",
      payload: {
        workspaceId: "ws_1",
        chatboxId: "sbx_1",
        name: "Asana Chatbox",
        description: "Hosted chatbox",
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
      surface: "chatbox",
      serverName: "Asana Production",
      serverUrl: "https://mcp.asana.com/sse",
    });

    render(<ChatboxChatPage />);

    expect(
      screen.getByRole("heading", { name: "Finishing authorization" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Authorize" })
    ).not.toBeInTheDocument();

    await act(async () => {
      hasToken = true;
      await vi.runAllTimersAsync();
    });

    expect(screen.getByTestId("chatbox-chat-tab")).toBeInTheDocument();
    expect(mockValidateHostedServer).toHaveBeenCalledWith(
      "srv_asana",
      undefined,
      undefined,
      {
        workspaceId: "ws_1",
        serverId: "srv_asana",
        serverName: "asana",
        accessScope: "chat_v2",
        chatboxToken: "chatbox-token",
      }
    );
    expect(mockValidateHostedServer).toHaveBeenCalledTimes(1);
  });

  it("shows curated copy instead of transport details when chatbox OAuth validation fails", async () => {
    vi.useFakeTimers();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mockGetStoredTokens.mockReturnValue({ access_token: "stale-token" });
    mockValidateHostedServer.mockRejectedValue(
      new Error(
        'Authentication failed for MCP server "mn70g96re2qn05cxjw7y4y26ah82jzgh": SSE error: SSE error: Non-200 status code (401)'
      )
    );

    writeChatboxSession({
      token: "chatbox-token",
      payload: {
        workspaceId: "ws_1",
        chatboxId: "sbx_1",
        name: "Asana Chatbox",
        description: "Hosted chatbox",
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

    render(<ChatboxChatPage />);

    expect(
      screen.getByRole("heading", { name: "Finishing authorization" })
    ).toBeInTheDocument();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(
      screen.getByRole("heading", { name: "Authorization Required" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your authorization expired or was rejected. Authorize again to continue."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/SSE error/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Non-200 status code/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Authorize again" })
    ).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      "[useHostedOAuthGate] OAuth validation failed",
      expect.objectContaining({
        surface: "chatbox",
        serverId: "srv_asana",
        serverName: "asana",
      })
    );
  });

  it("re-enters the chatbox OAuth gate when chat reports OAuth is required", async () => {
    mockGetStoredTokens.mockReturnValue({ access_token: "chatbox-token" });

    writeChatboxSession({
      token: "chatbox-token",
      payload: {
        workspaceId: "ws_1",
        chatboxId: "sbx_1",
        name: "Asana Chatbox",
        description: "Hosted chatbox",
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

    render(<ChatboxChatPage />);

    expect(await screen.findByTestId("chatbox-chat-tab")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Trigger OAuth" })
    );

    expect(
      screen.getByRole("heading", { name: "Authorization Required" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("You'll return here automatically after consent.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Authorize" })
    ).toBeInTheDocument();
  });

  it("re-opens auth only for the matching chatbox server when chat includes server details", async () => {
    mockGetStoredTokens.mockImplementation((serverName: string) => {
      if (serverName === "asana") {
        return { access_token: "asana-token" };
      }
      if (serverName === "linear") {
        return { access_token: "linear-token" };
      }
      return null;
    });

    writeChatboxSession({
      token: "chatbox-token",
      payload: {
        workspaceId: "ws_1",
        chatboxId: "sbx_1",
        name: "Asana Chatbox",
        description: "Hosted chatbox",
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

    render(<ChatboxChatPage />);

    expect(await screen.findByTestId("chatbox-chat-tab")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Trigger targeted OAuth" })
    );

    expect(
      screen.getByRole("heading", { name: "Authorization Required" })
    ).toBeInTheDocument();
    expect(screen.getByText("asana")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Authorize again" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("linear")).not.toBeInTheDocument();
  });

  describe("welcome dialog", () => {
    function nonOAuthServer() {
      return {
        serverId: "srv_tool",
        serverName: "tool",
        useOAuth: false,
        serverUrl: "https://mcp.example.com/sse",
        clientId: null,
        oauthScopes: null,
      };
    }

    it("shows welcome dialog when welcomeDialog is enabled and has content", async () => {
      writeChatboxSession({
        token: "chatbox-token",
        payload: {
          workspaceId: "ws_1",
          chatboxId: "sbx_welcome",
          name: "Welcome Chatbox",
          description: "",
          hostStyle: "claude",
          mode: "any_signed_in_with_link",
          allowGuestAccess: false,
          viewerIsWorkspaceMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.7,
          requireToolApproval: false,
          servers: [nonOAuthServer()],
          welcomeDialog: {
            enabled: true,
            body: "Welcome — thanks for trying this out.",
          },
        },
      });

      render(<ChatboxChatPage />);

      expect(
        await screen.findByText("Welcome — thanks for trying this out.")
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Get Started" })
      ).toBeInTheDocument();
      // Composer is blocked while the welcome is open
      expect(mockChatTabV2).toHaveBeenCalledWith(
        expect.objectContaining({ chatboxComposerBlocked: true })
      );
    });

    it("dismisses welcome and shows chat when Get Started is clicked", async () => {
      writeChatboxSession({
        token: "chatbox-token",
        payload: {
          workspaceId: "ws_1",
          chatboxId: "sbx_dismiss",
          name: "Welcome Chatbox",
          description: "",
          hostStyle: "claude",
          mode: "any_signed_in_with_link",
          allowGuestAccess: false,
          viewerIsWorkspaceMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.7,
          requireToolApproval: false,
          servers: [nonOAuthServer()],
          welcomeDialog: {
            enabled: true,
            body: "Welcome — thanks for trying this out.",
          },
        },
      });

      render(<ChatboxChatPage />);

      await userEvent.click(
        await screen.findByRole("button", { name: "Get Started" })
      );

      expect(
        screen.queryByText("Welcome — thanks for trying this out.")
      ).not.toBeInTheDocument();
      expect(await screen.findByTestId("chatbox-chat-tab")).toBeInTheDocument();
    });

    it("skips welcome and goes straight to chat when welcomeDialog.enabled is false", async () => {
      writeChatboxSession({
        token: "chatbox-token",
        payload: {
          workspaceId: "ws_1",
          chatboxId: "sbx_disabled",
          name: "No Welcome Chatbox",
          description: "",
          hostStyle: "claude",
          mode: "any_signed_in_with_link",
          allowGuestAccess: false,
          viewerIsWorkspaceMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.7,
          requireToolApproval: false,
          servers: [nonOAuthServer()],
          welcomeDialog: {
            enabled: false,
            body: "This should not appear.",
          },
        },
      });

      render(<ChatboxChatPage />);

      expect(await screen.findByTestId("chatbox-chat-tab")).toBeInTheDocument();
      expect(
        screen.queryByText("This should not appear.")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Get Started" })
      ).not.toBeInTheDocument();
    });

    it("skips welcome and goes straight to chat when welcomeDialog body is empty", async () => {
      writeChatboxSession({
        token: "chatbox-token",
        payload: {
          workspaceId: "ws_1",
          chatboxId: "sbx_emptybody",
          name: "Empty Body Chatbox",
          description: "",
          hostStyle: "claude",
          mode: "any_signed_in_with_link",
          allowGuestAccess: false,
          viewerIsWorkspaceMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.7,
          requireToolApproval: false,
          servers: [nonOAuthServer()],
          welcomeDialog: {
            enabled: true,
            body: "",
          },
        },
      });

      render(<ChatboxChatPage />);

      expect(await screen.findByTestId("chatbox-chat-tab")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Get Started" })
      ).not.toBeInTheDocument();
    });
  });
});
