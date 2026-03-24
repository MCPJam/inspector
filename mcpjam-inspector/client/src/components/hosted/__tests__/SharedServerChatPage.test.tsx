import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { SharedServerChatPage } from "../SharedServerChatPage";
import {
  clearSharedServerSession,
  writeSharedServerSession,
} from "@/lib/shared-server-session";
import {
  clearHostedOAuthResumeMarker,
  writeHostedOAuthResumeMarker,
} from "@/lib/hosted-oauth-resume";

const {
  mockResolveShareForViewer,
  mockGetAccessToken,
  mockClipboardWriteText,
  mockGetStoredTokens,
  mockInitiateOAuth,
  mockCheckHostedServerOAuthRequirement,
  mockValidateHostedServer,
  mockChatTabV2,
  toastSuccess,
  toastError,
} = vi.hoisted(() => ({
  mockResolveShareForViewer: vi.fn(),
  mockGetAccessToken: vi.fn(),
  mockClipboardWriteText: vi.fn(),
  mockGetStoredTokens: vi.fn(),
  mockInitiateOAuth: vi.fn(async () => ({ success: false })),
  mockCheckHostedServerOAuthRequirement: vi.fn(),
  mockValidateHostedServer: vi.fn(),
  mockChatTabV2: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
  useMutation: () => mockResolveShareForViewer,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: mockGetAccessToken,
  }),
}));

vi.mock("@/hooks/hosted/use-hosted-api-context", () => ({
  useHostedApiContext: vi.fn(),
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
        <div data-testid="shared-chat-tab" />
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
                  serverName: "Asana",
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

vi.mock("@/lib/apis/web/servers-api", () => ({
  checkHostedServerOAuthRequirement: mockCheckHostedServerOAuthRequirement,
  validateHostedServer: mockValidateHostedServer,
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

describe("SharedServerChatPage", () => {
  function createSharePayload(
    overrides: Partial<{
      workspaceId: string;
      serverId: string;
      serverName: string;
      mode: "any_signed_in_with_link" | "invited_only";
      viewerIsWorkspaceMember: boolean;
      useOAuth: boolean;
      serverUrl: string | null;
      clientId: string | null;
      oauthScopes: string[] | null;
    }> = {},
  ) {
    return {
      workspaceId: "ws_1",
      serverId: "srv_1",
      serverName: "Server One",
      mode: "any_signed_in_with_link" as const,
      viewerIsWorkspaceMember: false,
      useOAuth: false,
      serverUrl: null,
      clientId: null,
      oauthScopes: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.useRealTimers();
    clearSharedServerSession();
    clearHostedOAuthResumeMarker();
    localStorage.clear();
    sessionStorage.clear();
    mockResolveShareForViewer.mockReset();
    mockGetAccessToken.mockReset();
    mockClipboardWriteText.mockReset();
    mockGetStoredTokens.mockReset();
    mockInitiateOAuth.mockReset();
    mockCheckHostedServerOAuthRequirement.mockReset();
    mockValidateHostedServer.mockReset();
    mockChatTabV2.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();

    mockGetAccessToken.mockResolvedValue("workos-token");
    mockGetStoredTokens.mockReturnValue(null);
    mockInitiateOAuth.mockResolvedValue({ success: false });
    mockCheckHostedServerOAuthRequirement.mockResolvedValue({
      useOAuth: false,
      serverUrl: null,
    });
    mockValidateHostedServer.mockResolvedValue({
      success: true,
      status: "connected",
      initInfo: null,
    });
    mockClipboardWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: mockClipboardWriteText,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("copies the full shared path link from the header", async () => {
    writeSharedServerSession({
      token: "token 123",
      payload: createSharePayload(),
    });

    render(<SharedServerChatPage />);

    const copyButton = await screen.findByRole("button", { name: "Copy link" });
    await userEvent.click(copyButton);

    await waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith(
        `${window.location.origin}/shared/server-one/token%20123`,
      );
    });
    expect(toastSuccess).toHaveBeenCalledWith("Share link copied");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("keeps shared server reasoning rendering unchanged", async () => {
    writeSharedServerSession({
      token: "token-1",
      payload: createSharePayload(),
    });

    render(<SharedServerChatPage />);

    expect(await screen.findByTestId("shared-chat-tab")).toBeInTheDocument();
    expect(mockChatTabV2).toHaveBeenCalledWith(
      expect.not.objectContaining({
        reasoningDisplayMode: "hidden",
      }),
    );
  });

  it("auto-resumes hosted OAuth after callback completion", async () => {
    vi.useFakeTimers();
    let hasToken = false;
    mockGetStoredTokens.mockImplementation(() =>
      hasToken ? { access_token: "oauth-token" } : null,
    );

    writeSharedServerSession({
      token: "token-one",
      payload: createSharePayload({
        serverName: "Asana",
        serverId: "srv_asana",
        useOAuth: true,
        serverUrl: "https://mcp.asana.com/sse",
      }),
    });
    writeHostedOAuthResumeMarker({
      surface: "shared",
      serverName: "asana production",
      serverUrl: "https://mcp.asana.com/sse",
    });

    render(<SharedServerChatPage />);

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

    expect(screen.getByTestId("shared-chat-tab")).toBeInTheDocument();
    expect(mockValidateHostedServer).toHaveBeenCalledWith(
      "srv_asana",
      "oauth-token",
    );
    expect(mockValidateHostedServer).toHaveBeenCalledTimes(1);
  });

  it("marks runtime OAuth as required after switching a shared page into OAuth mode", async () => {
    mockGetStoredTokens.mockReturnValue({ access_token: "stale-token" });

    writeSharedServerSession({
      token: "token-runtime",
      payload: createSharePayload({
        serverId: "srv_asana",
        serverName: "Asana",
        useOAuth: false,
        serverUrl: null,
      }),
    });

    render(<SharedServerChatPage />);

    expect(await screen.findByTestId("shared-chat-tab")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Trigger targeted OAuth" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Authorization Required" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Asana requires authorization to continue. You'll return here automatically after consent.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Authorize" }),
    ).toBeInTheDocument();
    expect(mockValidateHostedServer).not.toHaveBeenCalled();
  });

  it("shows an explicit retry CTA when hosted OAuth validation keeps failing", async () => {
    vi.useFakeTimers();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mockGetStoredTokens.mockReturnValue({ access_token: "stale-token" });
    mockValidateHostedServer.mockRejectedValue(
      new Error("invalid_token from hosted validation"),
    );

    writeSharedServerSession({
      token: "token-fail",
      payload: createSharePayload({
        serverName: "Asana",
        serverId: "srv_asana",
        useOAuth: true,
        serverUrl: "https://mcp.asana.com/sse",
      }),
    });

    render(<SharedServerChatPage />);

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
    expect(
      screen.queryByText("invalid_token from hosted validation"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Authorize again" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("shared-chat-tab")).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      "[useHostedOAuthGate] OAuth validation failed",
      expect.objectContaining({
        surface: "shared",
        serverId: "srv_asana",
        serverName: "Asana",
      }),
    );
  });
});
