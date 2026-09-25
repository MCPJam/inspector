import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const guestState = vi.hoisted(() => ({
  session: null as { guestId: string; token: string; expiresAt: number } | null,
}));

vi.mock("../guest-session", () => ({
  getCachedGuestSession: () => guestState.session,
}));

import {
  loadBootstrapFeatureFlags,
  refreshServerFeatureFlagsForActor,
} from "../server-feature-flags";
import { VITE_PUBLIC_POSTHOG_KEY } from "../PosthogUtils";

const STORAGE_KEY = `ph_${VITE_PUBLIC_POSTHOG_KEY}_posthog`;

function flagsResponse(flags: unknown, status = 200) {
  return new Response(JSON.stringify({ flags }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestedUrl(callIndex = 0): URL {
  return new URL(
    String(vi.mocked(fetch).mock.calls[callIndex][0]),
    "http://localhost",
  );
}

function requestedAuthorization(callIndex = 0): string | null {
  const init = vi.mocked(fetch).mock.calls[callIndex][1] as RequestInit;
  return new Headers(init?.headers).get("authorization");
}

describe("server-evaluated feature flags", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    guestState.session = null;
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("loadBootstrapFeatureFlags", () => {
    it("asks the server for the persisted PostHog id's flags and keeps allowlisted keys", async () => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ distinct_id: "anon-device-1" }),
      );
      vi.mocked(fetch).mockResolvedValueOnce(
        flagsResponse({ "computers-enabled": true, "unlisted-flag": true }),
      );

      const flags = await loadBootstrapFeatureFlags();

      expect(flags).toEqual({ "computers-enabled": true });
      const url = requestedUrl();
      expect(url.pathname).toBe("/api/web/flags");
      expect(url.searchParams.get("distinct_id")).toBe("anon-device-1");
      expect(requestedAuthorization()).toBeNull();
    });

    it("falls back to the guest bootstrap id", async () => {
      guestState.session = {
        guestId: "guest-1",
        token: "guest-token",
        expiresAt: Date.now() + 60_000,
      };
      vi.mocked(fetch).mockResolvedValueOnce(flagsResponse({ xaa: false }));

      expect(await loadBootstrapFeatureFlags()).toEqual({ xaa: false });
      expect(requestedUrl().searchParams.get("distinct_id")).toBe("guest-1");
    });

    it("skips the request when no identity exists yet", async () => {
      expect(await loadBootstrapFeatureFlags()).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("resolves to null on a failure or an empty answer", async () => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ distinct_id: "anon-device-1" }),
      );
      vi.mocked(fetch)
        .mockResolvedValueOnce(flagsResponse({}, 500))
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(flagsResponse({}));

      expect(await loadBootstrapFeatureFlags()).toBeNull();
      expect(await loadBootstrapFeatureFlags()).toBeNull();
      expect(await loadBootstrapFeatureFlags()).toBeNull();
    });
  });

  describe("refreshServerFeatureFlagsForActor", () => {
    it("evaluates a signed-in actor through its access token", async () => {
      const posthog = { updateFlags: vi.fn() };
      vi.mocked(fetch).mockResolvedValueOnce(
        flagsResponse({ "billing-entitlements-ui": true }),
      );

      await refreshServerFeatureFlagsForActor(posthog, {
        actorKey: "user_1",
        isAuthedActor: true,
        getAccessToken: async () => "access-token",
      });

      expect(requestedAuthorization()).toBe("Bearer access-token");
      expect(posthog.updateFlags).toHaveBeenCalledWith({
        "billing-entitlements-ui": true,
      });
    });

    it("does not refresh a signed-in actor without a token", async () => {
      const posthog = { updateFlags: vi.fn() };

      await refreshServerFeatureFlagsForActor(posthog, {
        actorKey: "user_1",
        isAuthedActor: true,
        getAccessToken: async () => null,
      });

      expect(fetch).not.toHaveBeenCalled();
      expect(posthog.updateFlags).not.toHaveBeenCalled();
    });

    it("uses the guest token for the guest this tab holds", async () => {
      guestState.session = {
        guestId: "guest-1",
        token: "guest-token",
        expiresAt: Date.now() + 60_000,
      };
      const posthog = { updateFlags: vi.fn() };
      vi.mocked(fetch).mockResolvedValueOnce(flagsResponse({ xaa: true }));

      await refreshServerFeatureFlagsForActor(posthog, {
        actorKey: "guest-1",
        isAuthedActor: false,
      });

      expect(requestedAuthorization()).toBe("Bearer guest-token");
      expect(posthog.updateFlags).toHaveBeenCalledWith({ xaa: true });
    });

    it("keeps the current flags when the server has no values", async () => {
      const posthog = { updateFlags: vi.fn() };
      vi.mocked(fetch).mockResolvedValueOnce(flagsResponse({}));

      await refreshServerFeatureFlagsForActor(posthog, {
        actorKey: "anon-device-1",
        isAuthedActor: false,
      });

      expect(posthog.updateFlags).not.toHaveBeenCalled();
    });

    it("lets the newest refresh win", async () => {
      const posthog = { updateFlags: vi.fn() };
      let resolveFirst: (response: Response) => void = () => undefined;
      vi.mocked(fetch)
        .mockImplementationOnce(
          () => new Promise<Response>((resolve) => (resolveFirst = resolve)),
        )
        .mockResolvedValueOnce(flagsResponse({ xaa: true }));

      const first = refreshServerFeatureFlagsForActor(posthog, {
        actorKey: "anon-device-1",
        isAuthedActor: false,
      });
      await refreshServerFeatureFlagsForActor(posthog, {
        actorKey: "anon-device-2",
        isAuthedActor: false,
      });
      resolveFirst(flagsResponse({ xaa: false }));
      await first;

      expect(posthog.updateFlags).toHaveBeenCalledTimes(1);
      expect(posthog.updateFlags).toHaveBeenCalledWith({ xaa: true });
    });
  });
});
