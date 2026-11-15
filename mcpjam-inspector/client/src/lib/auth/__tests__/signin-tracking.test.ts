import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: trackMock }));
vi.mock("@/lib/PosthogUtils", () => ({ detectPlatform: () => "web" }));

import {
  PENDING_SIGN_IN_STORAGE_KEY,
  SIGN_IN_ABANDONED_AFTER_MS,
  readSignInLoad,
  settleSignInOnLoad,
  signInPlatform,
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

  it("drops a marker it does not recognize", () => {
    localStorage.setItem(PENDING_SIGN_IN_STORAGE_KEY, '{"intent":"other"}');
    settleSignInOnLoad("code_callback", true);
    expect(trackMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_SIGN_IN_STORAGE_KEY)).toBeNull();
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
