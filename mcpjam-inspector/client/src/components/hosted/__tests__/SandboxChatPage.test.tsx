import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SandboxChatPage } from "../SandboxChatPage";
import {
  SANDBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY,
  clearSandboxSession,
  writeSandboxSession,
} from "@/lib/sandbox-session";

const {
  mockConvexAuthState,
  mockGetAccessToken,
  mockSignIn,
  mockGetStoredTokens,
  mockInitiateOAuth,
} = vi.hoisted(() => ({
  mockConvexAuthState: {
    isAuthenticated: true,
    isLoading: false,
  },
  mockGetAccessToken: vi.fn(),
  mockSignIn: vi.fn(),
  mockGetStoredTokens: vi.fn(),
  mockInitiateOAuth: vi.fn(async () => ({ success: false })),
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

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: "light" }) => unknown) =>
    selector({ themeMode: "light" }),
}));

vi.mock("@/components/ChatTabV2", () => ({
  ChatTabV2: () => <div data-testid="sandbox-chat-tab" />,
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
    clearSandboxSession();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    mockConvexAuthState.isAuthenticated = true;
    mockConvexAuthState.isLoading = false;
    mockGetAccessToken.mockReset();
    mockSignIn.mockReset();
    mockGetStoredTokens.mockReset();
    mockInitiateOAuth.mockReset();

    mockGetAccessToken.mockResolvedValue("workos-token");
    mockGetStoredTokens.mockReturnValue(null);
    mockInitiateOAuth.mockResolvedValue({ success: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("applies sandbox host style data attributes and branding", async () => {
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
    expect(screen.getByAltText("ChatGPT")).toBeInTheDocument();
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
    expect(
      localStorage.getItem(SANDBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY),
    ).toBe("/sandbox/test/token-denied");
  });

  it("shows a generic fallback for unexpected sandbox bootstrap failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
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
    expect(screen.queryByText(/Internal database exploded/)).not.toBeInTheDocument();
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
});
