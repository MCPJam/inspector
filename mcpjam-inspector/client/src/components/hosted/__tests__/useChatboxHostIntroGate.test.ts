import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatboxHostIntroGate } from "../useChatboxHostIntroGate";

describe("useChatboxHostIntroGate", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("shows welcome when OAuth servers only need_auth and intro not dismissed", () => {
    const { result } = renderHook(() =>
      useChatboxHostIntroGate({
        chatboxId: "sbx_1",
        servers: [{ useOAuth: true }],
        oauthPending: true,
        hasBusyOAuth: false,
        pendingOAuthServers: [
          {
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
      useChatboxHostIntroGate({
        chatboxId: "sbx_1",
        servers: [{ useOAuth: true }],
        oauthPending: true,
        hasBusyOAuth: true,
        pendingOAuthServers: [
          {
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
      useChatboxHostIntroGate({
        chatboxId: "sbx_2",
        servers: [{ useOAuth: true }],
        oauthPending: true,
        hasBusyOAuth: false,
        pendingOAuthServers: [
          {
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
    expect(sessionStorage.getItem("chatbox-intro-dismissed-sbx_2")).toBe("1");
  });

  it("auto-persists intro dismissal when OAuth completes (not a non-OAuth first visit)", () => {
    const { rerender } = renderHook(
      ({ oauthPending }: { oauthPending: boolean }) =>
        useChatboxHostIntroGate({
          chatboxId: "sbx_3",
          servers: [{ useOAuth: true }],
          oauthPending,
          hasBusyOAuth: false,
          pendingOAuthServers: oauthPending
            ? [
                {
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

    expect(sessionStorage.getItem("chatbox-intro-dismissed-sbx_3")).toBe("1");
  });

  it("shows welcome for a no-server chatbox when welcome is available", () => {
    const { result } = renderHook(() =>
      useChatboxHostIntroGate({
        chatboxId: "sbx_noservers",
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

  it("does not auto-dismiss for a no-server chatbox so welcome stays visible each session", () => {
    const { result } = renderHook(() =>
      useChatboxHostIntroGate({
        chatboxId: "sbx_noservers2",
        servers: [],
        oauthPending: false,
        hasBusyOAuth: false,
        pendingOAuthServers: [],
        welcomeAvailable: true,
      }),
    );

    // Verify sessionStorage was NOT written (no auto-dismiss)
    expect(
      sessionStorage.getItem("chatbox-intro-dismissed-sbx_noservers2"),
    ).toBeNull();
    expect(result.current.showWelcome).toBe(true);
  });

  it("skips welcome entirely and unblocks composer when welcome is not available", () => {
    const { result } = renderHook(() =>
      useChatboxHostIntroGate({
        chatboxId: "sbx_skip",
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

  it("skips welcome but still shows auth panel when OAuth is pending and no welcome content", () => {
    const { result } = renderHook(() =>
      useChatboxHostIntroGate({
        chatboxId: "sbx_auth_only",
        servers: [{ useOAuth: true }],
        oauthPending: true,
        hasBusyOAuth: false,
        pendingOAuthServers: [
          {
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
