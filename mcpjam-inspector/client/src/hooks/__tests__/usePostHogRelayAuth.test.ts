import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  posthog: { set_config: vi.fn() },
  guestToken: null as string | null,
}));

vi.mock("posthog-js/react", () => ({ usePostHog: () => state.posthog }));
vi.mock("@/lib/guest-session", () => ({
  getCachedGuestSession: () =>
    state.guestToken ? { token: state.guestToken, guestId: "g" } : null,
}));

import {
  RELAY_AUTH_REFRESH_MS,
  usePostHogRelayAuth,
} from "../usePostHogRelayAuth";

type Props = Parameters<typeof usePostHogRelayAuth>[0];

const headers = () =>
  state.posthog.set_config.mock.calls.map(
    ([config]) => (config as { request_headers: unknown }).request_headers,
  );

describe("usePostHogRelayAuth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.posthog.set_config.mockClear();
    state.guestToken = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the signed-in user's bearer in request headers, never a URL", async () => {
    renderHook((props: Props) => usePostHogRelayAuth(props), {
      initialProps: {
        actorKey: "user_A",
        signedIn: true,
        getAccessToken: async () => "token-A",
      },
    });
    await act(async () => {});
    expect(headers()).toEqual([{}, { Authorization: "Bearer token-A" }]);
  });

  it("uses the guest session already in memory, minting nothing", async () => {
    state.guestToken = "guest-token";
    renderHook(() =>
      usePostHogRelayAuth({
        actorKey: "guest_1",
        signedIn: false,
        getAccessToken: async () => "unused",
      }),
    );
    await act(async () => {});
    expect(headers().at(-1)).toEqual({ Authorization: "Bearer guest-token" });
  });

  it("sends nothing without an actor", async () => {
    renderHook(() =>
      usePostHogRelayAuth({
        actorKey: null,
        signedIn: false,
        getAccessToken: async () => "unused",
      }),
    );
    await act(async () => {});
    expect(headers()).toEqual([{}]);
  });

  it("clears the bearer at once on an actor change and drops a late token for the previous actor", async () => {
    let releaseA: (token: string) => void = () => {};
    const { rerender } = renderHook(
      (props: Props) => usePostHogRelayAuth(props),
      {
        initialProps: {
          actorKey: "user_A",
          signedIn: true,
          getAccessToken: () =>
            new Promise<string>((resolve) => {
              releaseA = resolve;
            }),
        },
      },
    );
    rerender({
      actorKey: "user_B",
      signedIn: true,
      getAccessToken: async () => "token-B",
    });
    await act(async () => {
      releaseA("token-A");
    });
    expect(headers()).not.toContainEqual({ Authorization: "Bearer token-A" });
    expect(headers().at(-1)).toEqual({ Authorization: "Bearer token-B" });
  });

  it("re-reads the token on an interval", async () => {
    let n = 0;
    renderHook(() =>
      usePostHogRelayAuth({
        actorKey: "user_A",
        signedIn: true,
        getAccessToken: async () => `token-${++n}`,
      }),
    );
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(RELAY_AUTH_REFRESH_MS);
    });
    expect(headers().at(-1)).toEqual({ Authorization: "Bearer token-2" });
  });

  it("sends nothing when the token read fails", async () => {
    renderHook(() =>
      usePostHogRelayAuth({
        actorKey: "user_A",
        signedIn: true,
        getAccessToken: async () => {
          throw new Error("LoginRequiredError");
        },
      }),
    );
    await act(async () => {});
    expect(headers()).toEqual([{}, {}]);
  });
});
