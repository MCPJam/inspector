import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioChatPage } from "../ScenarioChatPage";
import {
  SCENARIO_SIGN_IN_RETURN_PATH_STORAGE_KEY,
  clearScenarioSession,
  readScenarioSession,
  writeScenarioSession,
} from "@/lib/scenario-session";
import {
  readScenarioChatTranscript,
  writeScenarioChatTranscript,
} from "@/lib/scenario-chat-transcript";
import {
  clearHostedOAuthResumeMarker,
  writeHostedOAuthResumeMarker,
} from "@/lib/hosted-oauth-resume";

const {
  mockConvexAuthState,
  mockWorkOsAuthState,
  mockGetAccessToken,
  mockSignIn,
  mockGetStoredTokens,
  mockInitiateOAuth,
  mockValidateHostedServer,
  mockCheckHostedServerOAuthRequirement,
  mockChatTabV2,
  mockUseApiContext,
  mockAuthFetch,
  mockPosthogCapture,
  mockIsEmbeddedPreview,
} = vi.hoisted(() => ({
  mockConvexAuthState: {
    isAuthenticated: true,
    isLoading: false,
  },
  mockWorkOsAuthState: {
    user: { id: "user_123" },
    isLoading: false,
  },
  mockGetAccessToken: vi.fn(),
  mockSignIn: vi.fn(),
  mockGetStoredTokens: vi.fn(),
  mockInitiateOAuth: vi.fn(async () => ({ success: false })),
  mockValidateHostedServer: vi.fn(),
  mockCheckHostedServerOAuthRequirement: vi.fn(),
  mockChatTabV2: vi.fn(),
  mockUseApiContext: vi.fn(),
  mockAuthFetch: vi.fn(),
  mockPosthogCapture: vi.fn(),
  mockIsEmbeddedPreview: vi.fn<() => boolean>(() => false),
}));

vi.mock("convex/react", () => ({
  // useChatSession resolves the Convex client to submit elicitation answers
  // straight to the rendezvous table (the blocked replica isn't addressable).
  useConvex: () => ({ mutation: vi.fn().mockResolvedValue({ ok: true }) }),
  useConvexAuth: () => mockConvexAuthState,
  // `useScenarioTurnRating` runs unconditionally (hooks rule) even when the
  // scenario has per-turn ratings off, so the double has to answer both.
  useMutation: () => vi.fn().mockResolvedValue({ status: "ok" }),
  useQuery: () => undefined,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: mockGetAccessToken,
    signIn: mockSignIn,
    user: mockWorkOsAuthState.user,
    isLoading: mockWorkOsAuthState.isLoading,
  }),
}));

vi.mock("@/hooks/hosted/use-hosted-api-context", () => ({
  useApiContext: mockUseApiContext,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: mockAuthFetch,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: mockPosthogCapture,
  }),
  useFeatureFlagEnabled: () => false,
}));

vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => mockPosthogCapture(...args),
}));

vi.mock("@/lib/apis/web/servers-api", () => ({
  validateHostedServer: mockValidateHostedServer,
  checkHostedServerOAuthRequirement: mockCheckHostedServerOAuthRequirement,
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
        <div data-testid="scenario-chat-tab" />
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

// jsdom can't put the page inside a real same-origin iframe, so stub the
// embed detector; the hash-sync helpers keep their real implementations.
vi.mock("@/lib/embedded-preview", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/embedded-preview")>();
  return {
    ...actual,
    isEmbeddedPreview: () => mockIsEmbeddedPreview(),
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("ScenarioChatPage", () => {
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
    clearScenarioSession();
    clearHostedOAuthResumeMarker();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    mockConvexAuthState.isAuthenticated = true;
    mockConvexAuthState.isLoading = false;
    mockWorkOsAuthState.user = { id: "user_123" };
    mockWorkOsAuthState.isLoading = false;
    mockGetAccessToken.mockReset();
    mockSignIn.mockReset();
    mockGetStoredTokens.mockReset();
    mockInitiateOAuth.mockReset();
    mockValidateHostedServer.mockReset();
    mockCheckHostedServerOAuthRequirement.mockReset();
    mockChatTabV2.mockReset();
    mockUseApiContext.mockReset();
    mockAuthFetch.mockReset();
    mockPosthogCapture.mockReset();
    mockIsEmbeddedPreview.mockReset();
    mockIsEmbeddedPreview.mockReturnValue(false);

    mockGetAccessToken.mockResolvedValue("workos-token");
    mockGetStoredTokens.mockReturnValue(null);
    mockInitiateOAuth.mockResolvedValue({ success: false });
    mockValidateHostedServer.mockResolvedValue({
      success: true,
      status: "connected",
      initInfo: null,
    });
    // These fixtures model genuinely OAuth-backed servers (asana, linear), so
    // the requirement probe says "yes" unless a test overrides it. The gate now
    // asks this instead of trusting the payload's `useOAuth` compat mirror.
    mockCheckHostedServerOAuthRequirement.mockResolvedValue({
      useOAuth: true,
      requiresAuthorization: true,
      effectiveAuthMethod: "oauth",
      serverUrl: null,
    });
    mockAuthFetch.mockResolvedValue(
      createFetchResponse({
        scenarioId: "sbx_1",
        accessVersion: 1,
        bootstrap: {
          projectId: "ws_1",
          scenarioId: "sbx_1",
          name: "Resolved Scenario",
          description: "Hosted scenario",
          hostStyle: "claude",
          mode: "invited_only",
          allowGuestAccess: false,
          viewerIsProjectMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.4,
          requireToolApproval: true,
          servers: [],
        },
      })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("applies scenario host style data attributes while keeping MCPJam branding", async () => {
    writeScenarioSession({
      scenarioId: "sbx_1",
      accessVersion: 1,
      payload: {
        projectId: "ws_1",
        scenarioId: "sbx_1",
        name: "ChatGPT Scenario",
        description: "Hosted scenario",
        hostStyle: "chatgpt",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsProjectMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
    });

    const { container } = render(<ScenarioChatPage />);

    expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();
    expect(
      container.querySelector('[data-host-style="chatgpt"]')
    ).toBeInTheDocument();
    expect(screen.getByAltText("MCPJam")).toBeInTheDocument();
    expect(mockChatTabV2).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningDisplayMode: "hidden",
      })
    );
  });

  it("does not brand the shell as Claude while the link is still redeeming", async () => {
    // Reported by testers on an org-invited scenario: the header showed the
    // Claude mark and the word "Claude" for the whole load, on a scenario that
    // wasn't a Claude host at all. The redeem is held open here so the
    // bootstrapping frame is the one under assertion.
    mockAuthFetch.mockImplementation(() => new Promise(() => {}));

    const { container } = render(<ScenarioChatPage pathToken="tok_loading" />);

    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());

    expect(
      container.querySelector('[data-host-style="claude"]')
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-host-style="mcpjam"]')
    ).toBeInTheDocument();
    // No host identity is claimed until the redeem says which host this is —
    // painting one brand and swapping to another reads as a glitch.
    expect(screen.queryByText("Claude")).not.toBeInTheDocument();
    expect(screen.getByAltText("MCPJam")).toBeInTheDocument();
  });

  it("does not wear the previous scenario's brand while a new link redeems", async () => {
    // sessionStorage outlives the page, so a tester opening a second link still
    // holds the first scenario's session. Dressing the redemption in that
    // scenario's host is the same impersonation as seeding one — the stored
    // session simply supplies the wrong vendor instead of a hardcoded one.
    writeScenarioSession({
      scenarioId: "sbx_previous",
      accessVersion: 1,
      shareToken: "tok_previous",
      payload: {
        projectId: "ws_1",
        scenarioId: "sbx_previous",
        name: "Previous Scenario",
        description: "Hosted scenario",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsProjectMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
    });
    mockAuthFetch.mockImplementation(() => new Promise(() => {}));

    const { container } = render(<ScenarioChatPage pathToken="tok_new" />);

    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());

    expect(
      container.querySelector('[data-host-style="claude"]')
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-host-style="mcpjam"]')
    ).toBeInTheDocument();
    expect(screen.queryByText("Claude")).not.toBeInTheDocument();
    expect(screen.getByAltText("MCPJam")).toBeInTheDocument();
  });

  // Removed: "uses the Claude loading indicator variant for Claude-style
  // hosted scenarios". The indicator no longer flows through a
  // `loadingIndicatorVariant` prop on ChatTabV2 — the inner thread reads
  // it from `ScenarioHostStyleProvider` context. Behavior is covered in
  // `LoadingIndicatorContent.test.tsx` and `Thread.test.tsx`.

  it("shows curated copy for an invalid or expired scenario link", async () => {
    mockAuthFetch.mockResolvedValueOnce(
      createFetchResponse(
        {
          code: "NOT_FOUND",
          message:
            "Uncaught Error: This scenario link is invalid or has expired. at resolveScenarioBootstrapForUser (../../convex/scenarios.ts:309:14) at async handler (../../convex/scenarios.ts:1088:6)",
        },
        { ok: false, status: 404, statusText: "Not Found" }
      )
    );

    render(<ScenarioChatPage pathToken="stale-token" />);

    expect(
      await screen.findByRole("heading", { name: "Link Unavailable" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This link is invalid or expired. Ask whoever shared it for a new one if you still need access."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Uncaught Error:/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/resolveScenarioBootstrapForUser/)
    ).not.toBeInTheDocument();
  });

  it("says a scenario was archived, rather than showing the generic failure", async () => {
    // The link redeemed fine and the access check passed — its environment was
    // archived on purpose. The backend authored the visitor-facing copy and
    // sends the reason in `details.code`; showing "we couldn't open this"
    // instead makes a deliberate retirement look like an outage.
    mockAuthFetch.mockResolvedValueOnce(
      createFetchResponse(
        {
          code: "CONFLICT",
          message:
            "This link has been archived by its owner and can no longer be opened.",
          details: { code: "ENV_ARCHIVED" },
        },
        { ok: false, status: 410, statusText: "Gone" }
      )
    );

    render(<ScenarioChatPage pathToken="archived-token" />);

    expect(
      await screen.findByRole("heading", { name: "This link has been archived" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This link has been archived by its owner and can no longer be opened."
      )
    ).toBeInTheDocument();
    // Signing in cannot un-archive an environment, so no sign-in CTA.
    expect(
      screen.queryByRole("button", { name: "Sign in" })
    ).not.toBeInTheDocument();
  });

  it("uses the not-archived copy for other environment failures", async () => {
    mockAuthFetch.mockResolvedValueOnce(
      createFetchResponse(
        {
          code: "CONFLICT",
          message:
            "This link isn't available right now — the setup behind it can't be loaded.",
          details: { code: "ENV_PLUGIN_UNAVAILABLE" },
        },
        { ok: false, status: 409, statusText: "Conflict" }
      )
    );

    render(<ScenarioChatPage pathToken="unresolvable-token" />);

    expect(
      await screen.findByRole("heading", {
        name: "This link isn't available right now",
      })
    ).toBeInTheDocument();
  });

  it("persists the redeemed session to sessionStorage when standalone", async () => {
    window.history.replaceState({}, "", "/user-testing/demo/scenario-token");

    render(<ScenarioChatPage pathToken="scenario-token" />);

    expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();
    await waitFor(() => {
      expect(readScenarioSession()?.scenarioId).toBe("sbx_1");
    });
  });

  it("keeps the embedded Preview iframe out of the tab-shared session", async () => {
    // The Preview pane iframe is same-origin, so it shares sessionStorage
    // with the outer dashboard. The embed must boot purely from its URL
    // token: never adopt the outer app's stored session, and never write
    // its own (a stored session makes the outer App render the scenario
    // runtime instead of the dashboard on the next reload).
    mockIsEmbeddedPreview.mockReturnValue(true);
    const outerSession = {
      scenarioId: "sbx_outer",
      accessVersion: 7,
      payload: {
        projectId: "ws_outer",
        scenarioId: "sbx_outer",
        name: "Outer Dashboard Scenario",
        description: "Hosted scenario",
        hostStyle: "chatgpt" as const,
        mode: "invited_only" as const,
        allowGuestAccess: false,
        viewerIsProjectMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
    };
    writeScenarioSession(outerSession);
    window.history.replaceState({}, "", "/user-testing/demo/scenario-token");

    render(<ScenarioChatPage pathToken="scenario-token" />);

    expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();
    // Booted by redeeming the URL token, not by adopting the stored session.
    expect(mockAuthFetch).toHaveBeenCalledWith(
      "/api/web/scenarios/redeem",
      expect.objectContaining({
        body: JSON.stringify({ scenarioToken: "scenario-token" }),
      })
    );
    // The outer app's session survives the embed untouched.
    expect(readScenarioSession()).toMatchObject({
      scenarioId: "sbx_outer",
      accessVersion: 7,
    });
  });

  it("drops the stored transcript when the link no longer redeems", async () => {
    // The other half of the teardown: a redeem that fails is just as terminal
    // as a revocation, and the resume must not outlive the grant.
    writeScenarioSession({
      scenarioId: "sbx_stale",
      accessVersion: 1,
      payload: {
        projectId: "ws_stale",
        scenarioId: "sbx_stale",
        name: "Stored Scenario",
        description: "Hosted scenario",
        hostStyle: "claude" as const,
        mode: "invited_only" as const,
        allowGuestAccess: false,
        viewerIsProjectMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
    });
    writeScenarioChatTranscript("sbx_stale", {
      chatSessionId: "chat-stale",
      messages: [
        { id: "user-1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ] as any[],
    });
    writeScenarioChatTranscript("sbx_other", {
      chatSessionId: "chat-other",
      messages: [
        { id: "user-2", role: "user", parts: [{ type: "text", text: "yo" }] },
      ] as any[],
    });
    mockAuthFetch.mockResolvedValue(
      createFetchResponse(
        { error: "Scenario link is no longer valid" },
        { ok: false, status: 404, statusText: "Not Found" }
      )
    );
    window.history.replaceState({}, "", "/user-testing/demo/scenario-token");

    render(<ScenarioChatPage pathToken="scenario-token" />);

    await waitFor(() => expect(readScenarioSession()).toBeNull());
    expect(readScenarioChatTranscript("sbx_stale")).toBeNull();
    // A different scenario the same tab happens to hold is left alone.
    expect(readScenarioChatTranscript("sbx_other")?.chatSessionId).toBe(
      "chat-other"
    );
  });

  it("leaves the tab-shared transcript alone inside the Preview embed", async () => {
    // Same rule as the session itself: the embed shares sessionStorage with the
    // outer dashboard, so it must neither read nor delete what lives there.
    mockIsEmbeddedPreview.mockReturnValue(true);
    writeScenarioChatTranscript("sbx_outer", {
      chatSessionId: "chat-outer",
      messages: [
        { id: "user-1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ] as any[],
    });
    mockAuthFetch.mockResolvedValue(
      createFetchResponse(
        { error: "Scenario link is no longer valid" },
        { ok: false, status: 404, statusText: "Not Found" }
      )
    );
    window.history.replaceState({}, "", "/user-testing/demo/scenario-token");

    render(<ScenarioChatPage pathToken="scenario-token" />);

    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    expect(readScenarioChatTranscript("sbx_outer")?.chatSessionId).toBe(
      "chat-outer"
    );
  });

  it("survives a teardown with no scenario id to clear", async () => {
    // No stored session, so the failing redeem has no scenario to name. The
    // clear must be a no-op rather than a crash — and must not sweep the tab.
    clearScenarioSession();
    writeScenarioChatTranscript("sbx_other", {
      chatSessionId: "chat-other",
      messages: [
        { id: "user-1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ] as any[],
    });
    mockAuthFetch.mockResolvedValue(
      createFetchResponse(
        { error: "Scenario link is no longer valid" },
        { ok: false, status: 404, statusText: "Not Found" }
      )
    );
    window.history.replaceState({}, "", "/user-testing/demo/scenario-token");

    render(<ScenarioChatPage pathToken="scenario-token" />);

    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    expect(readScenarioSession()).toBeNull();
    expect(readScenarioChatTranscript("sbx_other")?.chatSessionId).toBe(
      "chat-other"
    );
  });

  it("waits for active WorkOS and Convex loading to settle before bootstrapping the link", async () => {
    mockConvexAuthState.isAuthenticated = false;
    mockConvexAuthState.isLoading = true;
    mockWorkOsAuthState.user = { id: "user_settling" };
    mockWorkOsAuthState.isLoading = true;

    const { rerender } = render(<ScenarioChatPage pathToken="token-workos" />);

    expect(mockAuthFetch).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", {
        name: "Sign in",
      })
    ).not.toBeInTheDocument();
    expect(mockUseApiContext).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: null,
        serverIdsByName: {},
        scenarioId: undefined,
        accessVersion: undefined,
        isAuthenticated: true,
        hasSession: true,
      })
    );

    mockWorkOsAuthState.isLoading = false;
    mockConvexAuthState.isLoading = false;
    mockConvexAuthState.isAuthenticated = true;
    rerender(<ScenarioChatPage pathToken="token-workos" />);

    expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
    expect(mockAuthFetch).toHaveBeenCalledWith(
      "/api/web/scenarios/redeem",
      expect.objectContaining({
        body: JSON.stringify({ scenarioToken: "token-workos" }),
      })
    );
    expect(mockPosthogCapture).toHaveBeenCalledWith(
      "scenario_bootstrap_started",
      expect.objectContaining({
        surface: "scenario",
        auth_mode: "workos",
        status: "started",
      })
    );
  });

  it("does not stay stuck resolving auth when WorkOS is hydrated but Convex remains unauthenticated", async () => {
    mockConvexAuthState.isAuthenticated = false;
    mockConvexAuthState.isLoading = false;
    mockWorkOsAuthState.user = { id: "user_stalled_convex" };
    mockWorkOsAuthState.isLoading = false;
    mockAuthFetch.mockResolvedValueOnce(
      createFetchResponse(
        {
          code: "FORBIDDEN",
          message:
            "You don't have access to Test Scenario. This scenario is invite-only - ask the owner to invite you.",
        },
        { ok: false, status: 403, statusText: "Forbidden" }
      )
    );

    render(<ScenarioChatPage pathToken="token-stalled-convex" />);

    expect(
      await screen.findByRole("heading", { name: "Access Denied" })
    ).toBeInTheDocument();
    expect(mockAuthFetch).toHaveBeenCalledWith(
      "/api/web/scenarios/redeem",
      expect.objectContaining({
        body: JSON.stringify({ scenarioToken: "token-stalled-convex" }),
      })
    );
  });

  it("keeps the access denied sign-in path intact", async () => {
    mockConvexAuthState.isAuthenticated = false;
    mockWorkOsAuthState.user = null;
    window.history.replaceState({}, "", "/user-testing/test/token-denied");
    mockAuthFetch.mockResolvedValueOnce(
      createFetchResponse(
        {
          code: "FORBIDDEN",
          message:
            "You don't have access to Test Scenario. This scenario is invite-only - ask the owner to invite you.",
        },
        { ok: false, status: 403, statusText: "Forbidden" }
      )
    );

    render(<ScenarioChatPage pathToken="token-denied" />);

    expect(
      await screen.findByRole("heading", { name: "Access Denied" })
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Sign in",
      })
    );

    expect(mockSignIn).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(SCENARIO_SIGN_IN_RETURN_PATH_STORAGE_KEY)).toBe(
      "/user-testing/test/token-denied"
    );
  });

  /**
   * SUTB-6. The author's Preview embed must never be told to sign in: the
   * only sign-in the frame can perform returns to `/oauth/callback`, outside
   * the `main.tsx` self-embed exemption, so the frame lands on
   * `IframeRouterError`. The denial itself still shows — it's the honest
   * answer — minus the CTA that cannot work.
   */
  it("offers no sign-in CTA when the denial lands inside the preview embed", async () => {
    mockIsEmbeddedPreview.mockReturnValue(true);
    mockConvexAuthState.isAuthenticated = false;
    mockWorkOsAuthState.user = null;
    window.history.replaceState(
      {},
      "",
      "/user-testing/test/token-denied?surface=preview"
    );
    mockAuthFetch.mockResolvedValueOnce(
      createFetchResponse(
        {
          code: "FORBIDDEN",
          message:
            "You don't have access to Test Scenario. This scenario is invite-only - ask the owner to invite you.",
        },
        { ok: false, status: 403, statusText: "Forbidden" }
      )
    );

    render(<ScenarioChatPage pathToken="token-denied" />);

    expect(
      await screen.findByRole("heading", { name: "Access Denied" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sign in" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open in App" })
    ).toBeInTheDocument();
  });

  it("shows the sign-in CTA for guest-blocked links only after bootstrap denies access", async () => {
    mockConvexAuthState.isAuthenticated = false;
    mockWorkOsAuthState.user = null;
    mockAuthFetch.mockResolvedValueOnce(
      createFetchResponse(
        {
          code: "FORBIDDEN",
          message:
            "Guests cannot access Test Scenario. This scenario does not allow guest access.",
        },
        { ok: false, status: 403, statusText: "Forbidden" }
      )
    );

    render(<ScenarioChatPage pathToken="token-guest-blocked" />);

    expect(
      screen.queryByRole("button", {
        name: "Sign in",
      })
    ).not.toBeInTheDocument();

    expect(
      await screen.findByRole("heading", { name: "Access Denied" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Sign in",
      })
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(mockPosthogCapture).toHaveBeenCalledWith(
        "interactive_signin_required",
        expect.objectContaining({
          surface: "scenario",
          auth_mode: "guest",
          status: "required",
          error_kind: "guest_blocked",
        })
      )
    );
  });

  it("does not show the sign-in CTA when an authenticated viewer is denied", async () => {
    mockConvexAuthState.isAuthenticated = true;
    mockWorkOsAuthState.user = { id: "user_denied" };
    mockAuthFetch.mockResolvedValueOnce(
      createFetchResponse(
        {
          code: "FORBIDDEN",
          message:
            "You don't have access to Test Scenario. This scenario is invite-only - ask the owner to invite you.",
        },
        { ok: false, status: 403, statusText: "Forbidden" }
      )
    );

    render(<ScenarioChatPage pathToken="token-auth-denied" />);

    expect(
      await screen.findByRole("heading", { name: "Access Denied" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Sign in",
      })
    ).not.toBeInTheDocument();
  });

  it("shows a generic fallback for unexpected scenario bootstrap failures", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mockAuthFetch.mockResolvedValueOnce(
      createFetchResponse(
        {
          code: "INTERNAL_ERROR",
          message:
            "Uncaught Error: Internal database exploded at handler (../../convex/scenarios.ts:1088:6)",
        },
        { ok: false, status: 500, statusText: "Internal Server Error" }
      )
    );

    render(<ScenarioChatPage pathToken="broken-token" />);

    expect(
      await screen.findByRole("heading", { name: "Link Unavailable" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "We couldn't open this link right now. Please try again or open MCPJam."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Internal database exploded/)
    ).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      "[ScenarioChatPage] Failed to bootstrap scenario",
      expect.objectContaining({
        status: 500,
        code: "INTERNAL_ERROR",
        message: "Internal database exploded",
        rawMessage:
          "Uncaught Error: Internal database exploded at handler (../../convex/scenarios.ts:1088:6)",
      })
    );
  });

  it("auto-resumes scenario OAuth after callback completion", async () => {
    vi.useFakeTimers();
    let hasToken = false;
    mockGetStoredTokens.mockImplementation(() =>
      hasToken ? { access_token: "scenario-token" } : null
    );
    // Held open so the in-flight verification frame is observable: the
    // requirement probe now resolves before the gate reacts, so an immediately
    // resolving validation would settle in the same flush and the "Finishing
    // authorization" layer would never be rendered.
    let resolveValidation: ((value: unknown) => void) | null = null;
    mockValidateHostedServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveValidation = resolve;
        })
    );

    writeScenarioSession({
      scenarioId: "sbx_1",
      accessVersion: 1,
      payload: {
        projectId: "ws_1",
        scenarioId: "sbx_1",
        name: "Asana Scenario",
        description: "Hosted scenario",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsProjectMember: true,
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
      surface: "scenario",
      serverName: "Asana Production",
      serverUrl: "https://mcp.asana.com/sse",
    });

    render(<ScenarioChatPage />);

    // The gate admits a server only once the authorization requirement probe
    // has answered for it, so let that settle before asserting on the overlay.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      screen.getByRole("heading", { name: "Finishing authorization" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Authorize" })
    ).not.toBeInTheDocument();

    await act(async () => {
      hasToken = true;
      resolveValidation?.({
        success: true,
        status: "connected",
        initInfo: null,
      });
      await vi.runAllTimersAsync();
    });

    expect(screen.getByTestId("scenario-chat-tab")).toBeInTheDocument();
    expect(mockValidateHostedServer).toHaveBeenCalledWith(
      "srv_asana",
      undefined,
      undefined,
      expect.objectContaining({
        projectId: "ws_1",
        serverId: "srv_asana",
        serverName: "asana",
        accessScope: "chat_v2",
        scenarioId: "sbx_1",
      }),
    );
    expect(mockValidateHostedServer).toHaveBeenCalledTimes(1);
  });

  it("keeps guest scenario OAuth in first-consent welcome before callback completion", async () => {
    mockConvexAuthState.isAuthenticated = false;
    writeScenarioSession({
      scenarioId: "sbx_1",
      accessVersion: 1,
      payload: {
        projectId: "ws_1",
        scenarioId: "sbx_1",
        name: "Asana Scenario",
        description: "Hosted scenario",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: true,
        viewerIsProjectMember: false,
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
        chatUi: {
          surfaces: {
            welcome: {
              enabled: true,
              body: "Connect Asana before chatting.",
            },
          },
        },
      },
    });

    render(<ScenarioChatPage />);

    expect(
      await screen.findByText("Connect Asana before chatting.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Get Started" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Finishing authorization" })
    ).not.toBeInTheDocument();

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockValidateHostedServer).not.toHaveBeenCalled();
  });

  it("shows curated copy instead of transport details when scenario OAuth validation fails", async () => {
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

    writeScenarioSession({
      scenarioId: "sbx_1",
      accessVersion: 1,
      payload: {
        projectId: "ws_1",
        scenarioId: "sbx_1",
        name: "Asana Scenario",
        description: "Hosted scenario",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsProjectMember: true,
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

    render(<ScenarioChatPage />);

    // See above: the requirement probe resolves before the gate reacts.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

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
        surface: "scenario",
        serverId: "srv_asana",
        serverName: "asana",
      })
    );
  });

  it("re-enters the scenario OAuth gate when chat reports OAuth is required", async () => {
    mockGetStoredTokens.mockReturnValue({ access_token: "scenario-token" });

    writeScenarioSession({
      scenarioId: "sbx_1",
      accessVersion: 1,
      payload: {
        projectId: "ws_1",
        scenarioId: "sbx_1",
        name: "Asana Scenario",
        description: "Hosted scenario",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsProjectMember: true,
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

    render(<ScenarioChatPage />);

    expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();

    // Settle the gate before reporting the 401. A server joins the authorizable
    // set only once the requirement probe has answered for it, and it verifies
    // its stored credential after that — so clicking earlier races both, and
    // the resulting state depends on which promise won. An unblocked composer
    // is the observable "everything has settled" signal.
    await waitFor(() =>
      expect(mockChatTabV2).toHaveBeenLastCalledWith(
        expect.objectContaining({ scenarioComposerBlocked: false })
      )
    );

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

  it("re-opens auth only for the matching scenario server when chat includes server details", async () => {
    mockGetStoredTokens.mockImplementation((serverName: string) => {
      if (serverName === "asana") {
        return { access_token: "asana-token" };
      }
      if (serverName === "linear") {
        return { access_token: "linear-token" };
      }
      return null;
    });

    writeScenarioSession({
      scenarioId: "sbx_1",
      accessVersion: 1,
      payload: {
        projectId: "ws_1",
        scenarioId: "sbx_1",
        name: "Asana Scenario",
        description: "Hosted scenario",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsProjectMember: true,
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

    render(<ScenarioChatPage />);

    expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();

    // See above: let the probe answer and the credentials verify before the 401.
    await waitFor(() =>
      expect(mockChatTabV2).toHaveBeenLastCalledWith(
        expect.objectContaining({ scenarioComposerBlocked: false })
      )
    );

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

    it("shows welcome dialog when chatUi welcome surface is enabled and has content", async () => {
      writeScenarioSession({
        scenarioId: "sbx_1",
        accessVersion: 1,
        payload: {
          projectId: "ws_1",
          scenarioId: "sbx_welcome",
          name: "Welcome Scenario",
          description: "",
          hostStyle: "claude",
          mode: "anyone_with_link",
          allowGuestAccess: false,
          viewerIsProjectMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.7,
          requireToolApproval: false,
          servers: [nonOAuthServer()],
          chatUi: {
            surfaces: {
              welcome: {
                enabled: true,
                body: "Welcome — thanks for trying this out.",
              },
            },
          },
        },
      });

      render(<ScenarioChatPage />);

      expect(
        await screen.findByText("Welcome — thanks for trying this out.")
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Get Started" })
      ).toBeInTheDocument();
      // Composer is blocked while the welcome is open
      expect(mockChatTabV2).toHaveBeenCalledWith(
        expect.objectContaining({ scenarioComposerBlocked: true })
      );
    });

    it("dismisses welcome and shows chat when Get Started is clicked", async () => {
      writeScenarioSession({
        scenarioId: "sbx_1",
        accessVersion: 1,
        payload: {
          projectId: "ws_1",
          scenarioId: "sbx_dismiss",
          name: "Welcome Scenario",
          description: "",
          hostStyle: "claude",
          mode: "anyone_with_link",
          allowGuestAccess: false,
          viewerIsProjectMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.7,
          requireToolApproval: false,
          servers: [nonOAuthServer()],
          chatUi: {
            surfaces: {
              welcome: {
                enabled: true,
                body: "Welcome — thanks for trying this out.",
              },
            },
          },
        },
      });

      render(<ScenarioChatPage />);

      await userEvent.click(
        await screen.findByRole("button", { name: "Get Started" })
      );

      expect(
        screen.queryByText("Welcome — thanks for trying this out.")
      ).not.toBeInTheDocument();
      expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();
    });

    it("skips welcome and goes straight to chat when chatUi welcome.enabled is false", async () => {
      writeScenarioSession({
        scenarioId: "sbx_1",
        accessVersion: 1,
        payload: {
          projectId: "ws_1",
          scenarioId: "sbx_disabled",
          name: "No Welcome Scenario",
          description: "",
          hostStyle: "claude",
          mode: "anyone_with_link",
          allowGuestAccess: false,
          viewerIsProjectMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.7,
          requireToolApproval: false,
          servers: [nonOAuthServer()],
          chatUi: {
            surfaces: {
              welcome: {
                enabled: false,
                body: "This should not appear.",
              },
            },
          },
        },
      });

      render(<ScenarioChatPage />);

      expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();
      expect(
        screen.queryByText("This should not appear.")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Get Started" })
      ).not.toBeInTheDocument();
    });

    it("skips welcome and goes straight to chat when chatUi welcome body is empty", async () => {
      writeScenarioSession({
        scenarioId: "sbx_1",
        accessVersion: 1,
        payload: {
          projectId: "ws_1",
          scenarioId: "sbx_emptybody",
          name: "Empty Body Scenario",
          description: "",
          hostStyle: "claude",
          mode: "anyone_with_link",
          allowGuestAccess: false,
          viewerIsProjectMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.7,
          requireToolApproval: false,
          servers: [nonOAuthServer()],
          chatUi: {
            surfaces: {
              welcome: {
                enabled: true,
                body: "",
              },
            },
          },
        },
      });

      render(<ScenarioChatPage />);

      expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Get Started" })
      ).not.toBeInTheDocument();
    });
  });

  describe("access recovery", () => {
    function bootstrapPayload(overrides: Record<string, unknown> = {}) {
      return {
        projectId: "ws_1",
        scenarioId: "sbx_recover",
        name: "Recoverable Scenario",
        description: "Hosted scenario",
        hostStyle: "claude",
        mode: "anyone_with_link",
        allowGuestAccess: true,
        viewerIsProjectMember: false,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: false,
        servers: [],
        ...overrides,
      };
    }

    function latestHostedContext() {
      const calls = mockChatTabV2.mock.calls;
      const last = calls[calls.length - 1]?.[0] as
        | { hostedContext?: Record<string, unknown> }
        | undefined;
      return last?.hostedContext;
    }

    /**
     * Mounts with the share token in the path, lets the mount redeem settle,
     * then re-renders with no `pathToken` — which is exactly what the real App
     * does once `syncScenarioBootstrapHash` has stripped the token out of the
     * URL. Everything after this point has ONLY the persisted session's
     * `shareToken` to recover from.
     */
    async function renderPostStrip() {
      mockAuthFetch.mockResolvedValue(
        createFetchResponse({
          scenarioId: "sbx_recover",
          accessVersion: 1,
          bootstrap: bootstrapPayload(),
        })
      );

      const view = render(<ScenarioChatPage pathToken="tok_recover" />);
      expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();

      view.rerender(<ScenarioChatPage />);
      await waitFor(() =>
        expect(latestHostedContext()?.accessVersion).toBe(1)
      );
      mockAuthFetch.mockClear();
      return view;
    }

    it("re-redeems with the persisted share token after the URL strip", async () => {
      // The regression this whole path exists for: the old helper keyed off
      // the URL token, which is gone by now, so it early-returned forever and
      // no session could ever recover.
      await renderPostStrip();

      mockAuthFetch.mockResolvedValue(
        createFetchResponse({
          scenarioId: "sbx_recover",
          accessVersion: 9,
          bootstrap: bootstrapPayload(),
        })
      );

      const refresh = latestHostedContext()?.refreshAccessSession as () => Promise<{
        ok: boolean;
        accessVersion?: number;
      }>;
      const result = await act(async () => refresh());

      expect(result).toEqual({ ok: true, accessVersion: 9 });
      expect(mockAuthFetch).toHaveBeenCalledWith(
        "/api/web/scenarios/redeem",
        expect.objectContaining({
          body: JSON.stringify({ scenarioToken: "tok_recover" }),
        })
      );
      expect(readScenarioSession()?.accessVersion).toBe(9);
      await waitFor(() =>
        expect(latestHostedContext()?.accessVersion).toBe(9)
      );
    });

    it("coalesces concurrent refreshes onto one redeem round trip", async () => {
      // N chat lanes plus the widget-capture backoff must not each mint a
      // grant and race to write the session.
      await renderPostStrip();

      let releaseRedeem: (() => void) | undefined;
      mockAuthFetch.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          releaseRedeem = resolve;
        });
        return createFetchResponse({
          scenarioId: "sbx_recover",
          accessVersion: 4,
          bootstrap: bootstrapPayload(),
        });
      });

      const refresh = latestHostedContext()?.refreshAccessSession as () => Promise<{
        ok: boolean;
        accessVersion?: number;
      }>;

      const results = await act(async () => {
        const pending = Promise.all([refresh(), refresh(), refresh()]);
        await waitFor(() => expect(releaseRedeem).toBeDefined());
        releaseRedeem?.();
        return pending;
      });

      expect(mockAuthFetch).toHaveBeenCalledTimes(1);
      expect(results).toEqual([
        { ok: true, accessVersion: 4 },
        { ok: true, accessVersion: 4 },
        { ok: true, accessVersion: 4 },
      ]);
    });

    it("reports a definitively refused redeem as denied and leaves the session mounted", async () => {
      await renderPostStrip();

      mockAuthFetch.mockResolvedValue(
        createFetchResponse(
          {
            code: "SCENARIO_MEMBERS_ONLY",
            message: "You don't have access to Recoverable Scenario.",
          },
          { ok: false, status: 403, statusText: "Forbidden" }
        )
      );

      const refresh = latestHostedContext()?.refreshAccessSession as () => Promise<{
        ok: boolean;
        reason?: string;
        error?: { status: number };
      }>;
      const result = await act(async () => refresh());

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("denied");
      expect(result.error?.status).toBe(403);
      // Reporting is NOT tearing down: the caller decides, and a lane that
      // never sends again should keep its transcript.
      expect(readScenarioSession()?.accessVersion).toBe(1);
      expect(screen.getByTestId("scenario-chat-tab")).toBeInTheDocument();
    });

    it("treats a rate-limited redeem as transient, not terminal", async () => {
      // Recovering on `denied` costs one extra /redeem per denied send; a 429
      // from the backend's redeem limiter must not read as a revocation.
      await renderPostStrip();

      mockAuthFetch.mockResolvedValue(
        createFetchResponse(
          { code: "RATE_LIMITED", message: "Slow down." },
          { ok: false, status: 429, statusText: "Too Many Requests" }
        )
      );

      const refresh = latestHostedContext()?.refreshAccessSession as () => Promise<{
        ok: boolean;
        reason?: string;
      }>;
      const result = await act(async () => refresh());

      expect(result).toMatchObject({ ok: false, reason: "transient" });
      expect(screen.getByTestId("scenario-chat-tab")).toBeInTheDocument();
    });

    it("discards a refresh that resolves after navigating to a different scenario", async () => {
      // The staleness guard: a token swap while the redeem is in flight must
      // not install scenario A's freshly-minted session over scenario B's.
      const view = await renderPostStrip();

      // Only the FIRST redeem (the refresh under test) is held open; the
      // navigation's own mount redeem resolves immediately with a different
      // version so the two commits are distinguishable.
      let releaseFirstRedeem: (() => void) | undefined;
      let redeemCalls = 0;
      mockAuthFetch.mockImplementation(async () => {
        redeemCalls += 1;
        if (redeemCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstRedeem = resolve;
          });
          return createFetchResponse({
            scenarioId: "sbx_recover",
            accessVersion: 8,
            bootstrap: bootstrapPayload(),
          });
        }
        return createFetchResponse({
          scenarioId: "sbx_recover",
          accessVersion: 3,
          bootstrap: bootstrapPayload(),
        });
      });

      const refresh = latestHostedContext()?.refreshAccessSession as () => Promise<{
        ok: boolean;
        reason?: string;
      }>;

      const pending = refresh();
      await waitFor(() => expect(releaseFirstRedeem).toBeDefined());

      // Navigate to a DIFFERENT scenario while the redeem is in flight, and
      // let its effects flush so the live token is the new one.
      window.history.replaceState({}, "", "/user-testing/other/tok_other");
      view.rerender(<ScenarioChatPage pathToken="tok_other" />);
      await waitFor(() => expect(redeemCalls).toBeGreaterThanOrEqual(2));

      const result = await act(async () => {
        releaseFirstRedeem?.();
        return pending;
      });

      expect(result).toMatchObject({ ok: false, reason: "transient" });
      // The committed session is the navigation's (version 3), never the
      // resolved-but-stale refresh's (version 8).
      await waitFor(() =>
        expect(readScenarioSession()?.accessVersion).toBe(3)
      );
    });

    it("tears down to the denied landing when onAccessRevoked fires", async () => {
      await renderPostStrip();

      const onAccessRevoked = latestHostedContext()?.onAccessRevoked as (error: {
        status: number;
        code?: string;
        message: string;
      }) => void;

      act(() => {
        onAccessRevoked({
          status: 403,
          code: "SCENARIO_ACCESS_DENIED",
          message: "You don't have access to Recoverable Scenario.",
        });
      });

      expect(
        await screen.findByRole("heading", { name: "Access Denied" })
      ).toBeInTheDocument();
      expect(readScenarioSession()).toBeNull();
    });

    it("drops only the revoked scenario's transcript when access is lost", async () => {
      // Terminal access loss: the resume must go with the grant, or the tester
      // is offered a conversation for a scenario they can no longer open. Any
      // OTHER scenario's row in the same tab is none of this teardown's
      // business.
      await renderPostStrip();
      writeScenarioChatTranscript("sbx_recover", {
        chatSessionId: "chat-revoked",
        messages: [
          { id: "user-1", role: "user", parts: [{ type: "text", text: "hi" }] },
        ] as any[],
      });
      writeScenarioChatTranscript("sbx_other", {
        chatSessionId: "chat-other",
        messages: [
          { id: "user-2", role: "user", parts: [{ type: "text", text: "yo" }] },
        ] as any[],
      });

      const onAccessRevoked = latestHostedContext()?.onAccessRevoked as (error: {
        status: number;
        code?: string;
        message: string;
      }) => void;

      act(() => {
        onAccessRevoked({
          status: 403,
          code: "SCENARIO_ACCESS_DENIED",
          message: "You don't have access to Recoverable Scenario.",
        });
      });

      await waitFor(() => expect(readScenarioSession()).toBeNull());
      expect(readScenarioChatTranscript("sbx_recover")).toBeNull();
      expect(readScenarioChatTranscript("sbx_other")?.chatSessionId).toBe(
        "chat-other"
      );
    });

    it("in an embedded preview, refresh updates React state but never writes sessionStorage", async () => {
      // The embed shares the tab's sessionStorage with the outer dashboard;
      // writing there would hijack it on the next reload.
      mockIsEmbeddedPreview.mockReturnValue(true);
      mockAuthFetch.mockResolvedValue(
        createFetchResponse({
          scenarioId: "sbx_recover",
          accessVersion: 1,
          bootstrap: bootstrapPayload(),
        })
      );

      render(<ScenarioChatPage pathToken="tok_embed" />);
      expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();
      mockAuthFetch.mockClear();

      mockAuthFetch.mockResolvedValue(
        createFetchResponse({
          scenarioId: "sbx_recover",
          accessVersion: 5,
          bootstrap: bootstrapPayload(),
        })
      );

      const refresh = latestHostedContext()?.refreshAccessSession as () => Promise<{
        ok: boolean;
        accessVersion?: number;
      }>;
      const result = await act(async () => refresh());

      expect(result).toEqual({ ok: true, accessVersion: 5 });
      await waitFor(() =>
        expect(latestHostedContext()?.accessVersion).toBe(5)
      );
      expect(readScenarioSession()).toBeNull();
    });

    it("renders the denied landing for a SCENARIO_ACCESS_DENIED bootstrap failure", async () => {
      // The code is authoritative — no message-substring match required.
      window.history.replaceState({}, "", "/user-testing/test/tok_code_denied");
      mockAuthFetch.mockResolvedValueOnce(
        createFetchResponse(
          {
            code: "SCENARIO_ACCESS_DENIED",
            message: "This scenario could not be opened.",
          },
          { ok: false, status: 403, statusText: "Forbidden" }
        )
      );

      render(<ScenarioChatPage pathToken="tok_code_denied" />);

      expect(
        await screen.findByRole("heading", { name: "Access Denied" })
      ).toBeInTheDocument();
    });
  });

  describe("authorization is demanded only when the server needs it", () => {
    // SUTB-9: a shared scenario asked its recipient to authorize a server with
    // no OAuth at all. The bootstrap payload carries `useOAuth`, a derived
    // mirror that is true for a discover-mode (`authMethod: "auto"`) row too, so
    // gating on it prompts for servers that have nothing to authorize against —
    // and the only offered action, "Authorize again", can never succeed.
    function writeSharedScenario() {
      writeScenarioSession({
        scenarioId: "sbx_1",
        accessVersion: 1,
        payload: {
          projectId: "ws_1",
          scenarioId: "sbx_1",
          name: "Rabona Scenario",
          description: "Hosted scenario",
          hostStyle: "claude",
          mode: "invited_only",
          allowGuestAccess: false,
          viewerIsProjectMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.4,
          requireToolApproval: true,
          servers: [
            {
              serverId: "srv_rabona",
              serverName: "rabona",
              // The mirror the redeem payload actually sends for this row.
              useOAuth: true,
              serverUrl:
                "https://rabona.ignaciojimenezrocabado.workers.dev/mcp",
              clientId: null,
              oauthScopes: null,
            },
          ],
        },
      });
    }

    it("lets the recipient chat immediately when the server does not require authorization", async () => {
      mockCheckHostedServerOAuthRequirement.mockResolvedValue({
        useOAuth: true,
        requiresAuthorization: false,
        effectiveAuthMethod: "discover",
        serverUrl: "https://rabona.ignaciojimenezrocabado.workers.dev/mcp",
      });
      // A server with no OAuth has no credential to verify, so any attempt to
      // verify one fails — that failure is what used to render the dead-end
      // "Authorization could not be completed. Try again." card.
      mockValidateHostedServer.mockRejectedValue(
        new Error(
          'Authentication failed for MCP server "rabona": invalid_token (401)'
        )
      );
      writeSharedScenario();

      render(<ScenarioChatPage />);

      expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();
      await waitFor(() =>
        expect(mockCheckHostedServerOAuthRequirement).toHaveBeenCalledWith(
          "srv_rabona"
        )
      );
      expect(mockValidateHostedServer).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("heading", { name: "Authorization Required" })
      ).not.toBeInTheDocument();
      await waitFor(() =>
        expect(mockChatTabV2).toHaveBeenLastCalledWith(
          expect.objectContaining({ scenarioComposerBlocked: false })
        )
      );
    });

    it("still escalates that server to the auth gate on a real 401 at runtime", async () => {
      mockCheckHostedServerOAuthRequirement.mockResolvedValue({
        useOAuth: true,
        requiresAuthorization: false,
        effectiveAuthMethod: "discover",
        serverUrl: "https://rabona.ignaciojimenezrocabado.workers.dev/mcp",
      });
      writeSharedScenario();

      render(<ScenarioChatPage />);
      expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();

      await userEvent.click(
        screen.getByRole("button", { name: "Trigger OAuth" })
      );

      expect(
        screen.getByRole("heading", { name: "Authorization Required" })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Authorize" })
      ).toBeInTheDocument();
    });

    it("still prompts when the 401 beats the requirement probe", async () => {
      // A server joins the authorizable set only once the probe answers for it,
      // and the probe retries — so a real 401 can arrive while the set is still
      // empty. That escalation used to be dropped on the floor: it matched no
      // server and returned silently. For a `discover` row this is the whole
      // ballgame, because a runtime 401 is its only route to a prompt.
      let resolveProbe: (value: unknown) => void = () => {};
      mockCheckHostedServerOAuthRequirement.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveProbe = resolve;
          })
      );
      writeSharedScenario();

      render(<ScenarioChatPage />);
      expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();

      await userEvent.click(
        screen.getByRole("button", { name: "Trigger OAuth" })
      );
      expect(
        screen.queryByRole("heading", { name: "Authorization Required" })
      ).not.toBeInTheDocument();

      await act(async () => {
        resolveProbe({
          useOAuth: true,
          requiresAuthorization: false,
          effectiveAuthMethod: "discover",
          serverUrl: "https://rabona.ignaciojimenezrocabado.workers.dev/mcp",
        });
      });

      expect(
        await screen.findByRole("heading", { name: "Authorization Required" })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Authorize" })
      ).toBeInTheDocument();
    });

    it("keeps the runtime prompt when a late probe answer rebuilds the gate", async () => {
      // The probe answering flips `authorizationRequiredUpfront`, which rebuilds
      // the status map from the descriptors. That rebuild must not retract a
      // prompt the wire already proved is needed. It used to: the ids meant to
      // survive it were collected inside a `setState` updater, which React runs
      // lazily during render, so the guarding set was still empty when read.
      let resolveProbe: (value: unknown) => void = () => {};
      mockCheckHostedServerOAuthRequirement.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveProbe = resolve;
          })
      );
      writeSharedScenario();

      render(<ScenarioChatPage />);
      expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();

      await userEvent.click(
        screen.getByRole("button", { name: "Trigger OAuth" })
      );

      // "No authorization needed" is the weakest possible answer, and still not
      // enough to overturn a 401 already observed on the wire.
      await act(async () => {
        resolveProbe({
          useOAuth: true,
          requiresAuthorization: false,
          effectiveAuthMethod: "discover",
          serverUrl: "https://rabona.ignaciojimenezrocabado.workers.dev/mcp",
        });
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(
        await screen.findByRole("heading", { name: "Authorization Required" })
      ).toBeInTheDocument();
    });

    it("does not let a verification that started earlier erase a newer 401", async () => {
      mockCheckHostedServerOAuthRequirement.mockResolvedValue({
        useOAuth: true,
        requiresAuthorization: true,
        effectiveAuthMethod: "oauth",
        serverUrl: "https://rabona.ignaciojimenezrocabado.workers.dev/mcp",
      });
      // Hold the credential check open so the 401 lands while it is in flight.
      let resolveValidation: (value: unknown) => void = () => {};
      mockValidateHostedServer.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveValidation = resolve;
          })
      );
      writeSharedScenario();

      render(<ScenarioChatPage />);
      expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();

      await waitFor(() => expect(mockValidateHostedServer).toHaveBeenCalled());

      await userEvent.click(
        screen.getByRole("button", { name: "Trigger OAuth" })
      );
      expect(
        await screen.findByRole("heading", { name: "Authorization Required" })
      ).toBeInTheDocument();

      // The verification now succeeds — but it was asking about a credential the
      // 401 has since disproved, so its answer is stale and must not stand.
      await act(async () => {
        resolveValidation({ success: true, status: "connected", initInfo: null });
      });

      expect(
        screen.getByRole("heading", { name: "Authorization Required" })
      ).toBeInTheDocument();
    });

    it("prompts the recipient when the server does require authorization", async () => {
      mockCheckHostedServerOAuthRequirement.mockResolvedValue({
        useOAuth: true,
        requiresAuthorization: true,
        effectiveAuthMethod: "oauth",
        serverUrl: "https://rabona.ignaciojimenezrocabado.workers.dev/mcp",
      });
      // No usable credential for the recipient yet.
      mockValidateHostedServer.mockRejectedValue(
        new Error(
          'Authentication failed for MCP server "rabona": invalid_token (401)'
        )
      );
      vi.spyOn(console, "error").mockImplementation(() => {});
      writeSharedScenario();

      render(<ScenarioChatPage />);

      // Settle on the terminal state: the row passes through needs_auth and
      // verifying on the way here, and only "error" stays put.
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Authorize again" })
        ).toBeInTheDocument()
      );
      expect(
        screen.getByRole("heading", { name: "Authorization Required" })
      ).toBeInTheDocument();
      expect(
        screen.getByText("Authorize the required servers to continue.")
      ).toBeInTheDocument();
      expect(mockChatTabV2).toHaveBeenLastCalledWith(
        expect.objectContaining({ scenarioComposerBlocked: true })
      );
    });

    it("lets an authorized recipient chat once the credential verifies", async () => {
      mockCheckHostedServerOAuthRequirement.mockResolvedValue({
        useOAuth: true,
        requiresAuthorization: true,
        effectiveAuthMethod: "oauth",
        serverUrl: "https://rabona.ignaciojimenezrocabado.workers.dev/mcp",
      });
      writeSharedScenario();

      render(<ScenarioChatPage />);

      expect(await screen.findByTestId("scenario-chat-tab")).toBeInTheDocument();
      await waitFor(() =>
        expect(mockChatTabV2).toHaveBeenLastCalledWith(
          expect.objectContaining({ scenarioComposerBlocked: false })
        )
      );
      expect(
        screen.queryByRole("heading", { name: "Authorization Required" })
      ).not.toBeInTheDocument();
    });

    it("releases the composer when the offered authorization cannot succeed", async () => {
      mockCheckHostedServerOAuthRequirement.mockResolvedValue({
        useOAuth: true,
        requiresAuthorization: true,
        effectiveAuthMethod: "oauth",
        serverUrl: "https://rabona.ignaciojimenezrocabado.workers.dev/mcp",
      });
      // The reported dead end: the card's only action cannot complete.
      mockValidateHostedServer.mockRejectedValue(
        new Error(
          'Authentication failed for MCP server "rabona": invalid_token (401)'
        )
      );
      vi.spyOn(console, "error").mockImplementation(() => {});
      writeSharedScenario();

      render(<ScenarioChatPage />);

      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Authorize again" })
        ).toBeInTheDocument()
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Continue without authorizing" })
      );

      expect(
        screen.queryByRole("heading", { name: "Authorization Required" })
      ).not.toBeInTheDocument();
      await waitFor(() =>
        expect(mockChatTabV2).toHaveBeenLastCalledWith(
          expect.objectContaining({ scenarioComposerBlocked: false })
        )
      );
    });
  });
});
