import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { trackMock, telemetry } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  telemetry: { disabled: false, loaded: true, optedOut: false },
}));
vi.mock("@/lib/analytics", () => ({ track: trackMock }));
vi.mock("@/lib/PosthogUtils", () => ({
  detectPlatform: () => "web",
  get isPostHogDisabled() {
    return telemetry.disabled;
  },
}));
vi.mock("posthog-js", () => ({
  default: {
    get __loaded() {
      return telemetry.loaded;
    },
    has_opted_out_capturing: () => telemetry.optedOut,
  },
}));

import {
  PENDING_SIGN_IN_STORAGE_KEY,
  SIGN_IN_ABANDONED_AFTER_MS,
  readSignInLoad,
  settleSignInOnLoad,
  signInPlatform,
  trackSignInFailedBeforeRedirect,
  trackSignInStarted,
} from "../signin-tracking";
import { startWorkosAuth } from "../workos-auth-start";
import { useWorkosAuthUnavailableStore } from "@/stores/workos-auth-unavailable-store";

const attempt = { intent: "sign_in", location: "app" } as const;
const base = { location: "app", intent: "sign_in", signin_platform: "web" };

function events() {
  return trackMock.mock.calls.map(([name, props]) => [name, props]);
}

beforeEach(() => {
  trackMock.mockClear();
  Object.assign(telemetry, { disabled: false, loaded: true, optedOut: false });
  localStorage.clear();
  useWorkosAuthUnavailableStore.getState().dismiss();
});
afterEach(() => vi.useRealTimers());

describe("startWorkosAuth", () => {
  it("fires started and keeps the attempt open across the redirect", async () => {
    const start = vi.fn();
    expect(await startWorkosAuth(start, attempt, "https://app.mcpjam.com")).toBe(
      "started",
    );
    expect(start).toHaveBeenCalledOnce();
    expect(events()).toEqual([["signin_started", base]]);
    expect(localStorage.getItem(PENDING_SIGN_IN_STORAGE_KEY)).not.toBeNull();
  });

  it("fails an insecure LAN origin before the WorkOS redirect", async () => {
    const start = vi.fn();
    expect(
      await startWorkosAuth(start, attempt, "http://192.168.1.50:6274"),
    ).toBe("blocked");
    expect(start).not.toHaveBeenCalled();
    expect(events()).toEqual([
      ["signin_started", base],
      ["signin_failed", { ...base, reason: "insecure_origin" }],
    ]);
    expect(localStorage.getItem(PENDING_SIGN_IN_STORAGE_KEY)).toBeNull();
    expect(useWorkosAuthUnavailableStore.getState().open).toBe(true);
  });

  it("fails an insecure origin when the marker cannot be stored", async () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await startWorkosAuth(vi.fn(), attempt, "http://192.168.1.50:6274");
    expect(events()).toEqual([
      ["signin_started", base],
      ["signin_failed", { ...base, reason: "insecure_origin" }],
    ]);
  });

  it("fails and rethrows when building the authorization URL throws", async () => {
    const error = new Error("no crypto");
    await expect(
      startWorkosAuth(
        () => Promise.reject(error),
        { intent: "sign_up", location: "session-refresh" },
        "https://app.mcpjam.com",
      ),
    ).rejects.toBe(error);
    const props = { ...base, intent: "sign_up", location: "session-refresh" };
    expect(events()).toEqual([
      ["signin_started", props],
      ["signin_failed", { ...props, reason: "start_error" }],
    ]);
    expect(localStorage.getItem(PENDING_SIGN_IN_STORAGE_KEY)).toBeNull();
  });
});

describe("settleSignInOnLoad", () => {
  it.each([
    ["code_callback", true, ["signin_completed", base]],
    [
      "code_callback",
      false,
      ["signin_failed", { ...base, reason: "code_exchange_failed" }],
    ],
    [
      "error_callback",
      false,
      ["signin_failed", { ...base, reason: "callback_error" }],
    ],
  ] as const)("settles a %s (signed in: %s) once", (load, signedIn, ending) => {
    trackSignInStarted(attempt);
    trackMock.mockClear();
    settleSignInOnLoad(load, signedIn);
    settleSignInOnLoad(load, signedIn);
    expect(events()).toEqual([ending]);
  });

  it("ignores a callback with no attempt of its own", () => {
    settleSignInOnLoad("code_callback", true);
    expect(trackMock).not.toHaveBeenCalled();
  });

  it("reports an attempt abandoned only after 30 minutes without a callback", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    trackSignInStarted(attempt);
    trackMock.mockClear();
    settleSignInOnLoad("other", false, 1_000_000 + SIGN_IN_ABANDONED_AFTER_MS - 1);
    expect(trackMock).not.toHaveBeenCalled();
    settleSignInOnLoad("other", false, 1_000_000 + SIGN_IN_ABANDONED_AFTER_MS);
    expect(events()).toEqual([
      ["signin_failed", { ...base, reason: "abandoned" }],
    ]);
    expect(localStorage.getItem(PENDING_SIGN_IN_STORAGE_KEY)).toBeNull();
  });

  it("abandons an open attempt when a new one starts", () => {
    trackSignInStarted(attempt);
    trackSignInStarted({ intent: "sign_up", location: "promo_redemption" });
    expect(events().slice(1)).toEqual([
      ["signin_failed", { ...base, reason: "abandoned" }],
      [
        "signin_started",
        { ...base, intent: "sign_up", location: "promo_redemption" },
      ],
    ]);
  });

  it("does not let a superseded attempt clear the newer one's marker", () => {
    const first = trackSignInStarted(attempt);
    // Another tab starts its own attempt before the first one's start fails.
    trackSignInStarted({ intent: "sign_up", location: "promo_redemption" });
    trackMock.mockClear();
    trackSignInFailedBeforeRedirect(first, attempt, "start_error");
    expect(trackMock).not.toHaveBeenCalled();
    settleSignInOnLoad("code_callback", true);
    expect(events()).toEqual([
      [
        "signin_completed",
        { ...base, intent: "sign_up", location: "promo_redemption" },
      ],
    ]);
  });

  it("does not report a callback settled while opted out as abandoned later", () => {
    trackSignInStarted(attempt);
    telemetry.optedOut = true;
    settleSignInOnLoad("code_callback", true);
    telemetry.optedOut = false;
    trackMock.mockClear();
    trackSignInStarted(attempt);
    expect(events()).toEqual([["signin_started", base]]);
  });

  it("drops a marker it does not recognize", () => {
    localStorage.setItem(PENDING_SIGN_IN_STORAGE_KEY, '{"intent":"other"}');
    settleSignInOnLoad("code_callback", true);
    expect(trackMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_SIGN_IN_STORAGE_KEY)).toBeNull();
  });
});

describe.each([
  ["telemetry is disabled", { disabled: true }, false],
  ["the user opted out", { optedOut: true }, false],
  ["PostHog was never initialized", { loaded: false }, true],
])("when %s", (_, state, keepsMarker) => {
  it("neither writes the marker nor sends an event", async () => {
    Object.assign(telemetry, state);
    expect(
      await startWorkosAuth(vi.fn(), attempt, "http://192.168.1.50:6274"),
    ).toBe("blocked");
    expect(trackSignInStarted(attempt)).toBeNull();
    expect(localStorage.getItem(PENDING_SIGN_IN_STORAGE_KEY)).toBeNull();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it("settles a callback without sending an event", () => {
    trackSignInStarted(attempt);
    const marker = localStorage.getItem(PENDING_SIGN_IN_STORAGE_KEY);
    trackMock.mockClear();
    Object.assign(telemetry, state);
    settleSignInOnLoad("code_callback", true);
    expect(trackMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_SIGN_IN_STORAGE_KEY)).toBe(
      keepsMarker ? marker : null,
    );
  });
});

describe("readSignInLoad", () => {
  const redirect = "https://app.mcpjam.com/callback";
  it.each([
    ["https://app.mcpjam.com/callback?code=c&state=s", "code_callback"],
    ["https://app.mcpjam.com/callback/?code=c", "code_callback"],
    ["https://app.mcpjam.com/callback?error=access_denied", "error_callback"],
    ["https://app.mcpjam.com/callback", "other"],
    ["https://app.mcpjam.com/servers?code=c", "other"],
  ])("reads %s as %s", (href, load) => {
    expect(readSignInLoad(href, redirect)).toBe(load);
  });

  it("resolves a relative redirect URI against the page", () => {
    expect(readSignInLoad("http://localhost:6274/callback?code=c", "/callback")).toBe(
      "code_callback",
    );
  });
});

it.each([
  ["web", "web"],
  ["docker", "web"],
  ["npm", "npx"],
  ["mac", "desktop"],
  ["win", "desktop"],
  ["electron", "desktop"],
])("maps platform %s to %s", (platform, expected) => {
  expect(signInPlatform(platform)).toBe(expected);
});
