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
        }),
      { initialProps: { oauthPending: true } },
    );

    rerender({ oauthPending: false });

    expect(sessionStorage.getItem("chatbox-intro-dismissed-sbx_3")).toBe("1");
  });
});
