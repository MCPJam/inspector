import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScenarioHostIntroGate } from "../useScenarioHostIntroGate";

describe("useScenarioHostIntroGate", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("shows welcome when OAuth servers only need_auth and intro not dismissed", () => {
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_1",
        servers: [{ useOAuth: true }],
        oauthPending: true,
        hasBusyOAuth: false,
        pendingOAuthServers: [
          {
            server: { serverId: "srv_1" },
            state: {
              status: "needs_auth",
              errorMessage: null,
              serverUrl: null,
            },
          },
        ],
        welcomeAvailable: true,
      }),
    );

    expect(result.current.showWelcome).toBe(true);
    expect(result.current.showAuthPanel).toBe(false);
    expect(result.current.composerBlocked).toBe(true);
  });

  it("shows auth panel instead of welcome while OAuth is busy", () => {
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_1",
        servers: [{ useOAuth: true }],
        oauthPending: true,
        hasBusyOAuth: true,
        pendingOAuthServers: [
          {
            server: { serverId: "srv_1" },
            state: { status: "verifying", errorMessage: null, serverUrl: null },
          },
        ],
        welcomeAvailable: true,
      }),
    );

    expect(result.current.showWelcome).toBe(false);
    expect(result.current.showAuthPanel).toBe(true);
  });

  it("dismisses intro and hides welcome after dismissIntro", () => {
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_2",
        servers: [{ useOAuth: true }],
        oauthPending: true,
        hasBusyOAuth: false,
        pendingOAuthServers: [
          {
            server: { serverId: "srv_1" },
            state: {
              status: "needs_auth",
              errorMessage: null,
              serverUrl: null,
            },
          },
        ],
        welcomeAvailable: true,
      }),
    );

    expect(result.current.showWelcome).toBe(true);

    act(() => {
      result.current.dismissIntro();
    });

    expect(result.current.showWelcome).toBe(false);
    expect(result.current.showAuthPanel).toBe(true);
    expect(sessionStorage.getItem("scenario-intro-dismissed-sbx_2")).toBe("1");
  });

  it("auto-persists intro dismissal when OAuth completes (not a non-OAuth first visit)", () => {
    const { rerender } = renderHook(
      ({ oauthPending }: { oauthPending: boolean }) =>
        useScenarioHostIntroGate({
          scenarioId: "sbx_3",
          servers: [{ useOAuth: true }],
          oauthPending,
          hasBusyOAuth: false,
          pendingOAuthServers: oauthPending
            ? [
                {
                  server: { serverId: "srv_1" },
                  state: {
                    status: "needs_auth",
                    errorMessage: null,
                    serverUrl: null,
                  },
                },
              ]
            : [],
          welcomeAvailable: true,
        }),
      { initialProps: { oauthPending: true } },
    );

    rerender({ oauthPending: false });

    expect(sessionStorage.getItem("scenario-intro-dismissed-sbx_3")).toBe("1");
  });

  it("shows welcome for a no-server scenario when welcome is available", () => {
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_noservers",
        servers: [],
        oauthPending: false,
        hasBusyOAuth: false,
        pendingOAuthServers: [],
        welcomeAvailable: true,
      }),
    );

    expect(result.current.showWelcome).toBe(true);
    expect(result.current.composerBlocked).toBe(true);
  });

  it("does not auto-dismiss for a no-server scenario so welcome stays visible each session", () => {
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_noservers2",
        servers: [],
        oauthPending: false,
        hasBusyOAuth: false,
        pendingOAuthServers: [],
        welcomeAvailable: true,
      }),
    );

    // Verify sessionStorage was NOT written (no auto-dismiss)
    expect(
      sessionStorage.getItem("scenario-intro-dismissed-sbx_noservers2"),
    ).toBeNull();
    expect(result.current.showWelcome).toBe(true);
  });

  it("skips welcome entirely and unblocks composer when welcome is not available", () => {
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_skip",
        servers: [{ useOAuth: false }],
        oauthPending: false,
        hasBusyOAuth: false,
        pendingOAuthServers: [],
        welcomeAvailable: false,
      }),
    );

    expect(result.current.showWelcome).toBe(false);
    expect(result.current.showAuthPanel).toBe(false);
    expect(result.current.composerBlocked).toBe(false);
  });

  it("treats a discover server as non-OAuth even though useOAuth mirrors true", () => {
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_discover",
        servers: [{ useOAuth: true, authorizationRequiredUpfront: false }],
        oauthPending: false,
        hasBusyOAuth: false,
        pendingOAuthServers: [],
        welcomeAvailable: true,
      }),
    );

    // Counted as an OAuth scenario, this one skipped its welcome overlay.
    expect(result.current.showWelcome).toBe(true);
    expect(result.current.showAuthPanel).toBe(false);
  });

  it("releases the composer on dismissAuthPanel and re-arms on a new requirement", () => {
    const errorRow = {
      server: { serverId: "srv_1" },
      state: { status: "error", errorMessage: "nope", serverUrl: null },
    };
    const { result, rerender } = renderHook(
      ({ pending }: { pending: (typeof errorRow)[] }) =>
        useScenarioHostIntroGate({
          scenarioId: "sbx_deadend",
          servers: [{ useOAuth: true }],
          oauthPending: true,
          hasBusyOAuth: false,
          pendingOAuthServers: pending,
          welcomeAvailable: false,
        }),
      { initialProps: { pending: [errorRow] } },
    );

    expect(result.current.composerBlocked).toBe(true);

    act(() => {
      result.current.dismissAuthPanel();
    });

    expect(result.current.showAuthPanel).toBe(false);
    expect(result.current.composerBlocked).toBe(false);

    // A later 401 on another server is new information, not a dismissed one.
    rerender({
      pending: [
        {
          server: { serverId: "srv_2" },
          state: { status: "needs_auth", errorMessage: null, serverUrl: null },
        },
      ],
    });

    expect(result.current.showAuthPanel).toBe(true);
  });

  it("skips welcome but still shows auth panel when OAuth is pending and no welcome content", () => {
    const { result } = renderHook(() =>
      useScenarioHostIntroGate({
        scenarioId: "sbx_auth_only",
        servers: [{ useOAuth: true }],
        oauthPending: true,
        hasBusyOAuth: false,
        pendingOAuthServers: [
          {
            server: { serverId: "srv_1" },
            state: {
              status: "needs_auth",
              errorMessage: null,
              serverUrl: null,
            },
          },
        ],
        welcomeAvailable: false,
      }),
    );

    expect(result.current.showWelcome).toBe(false);
    expect(result.current.showAuthPanel).toBe(true);
  });
});
