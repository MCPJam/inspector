import { describe, expect, it } from "vitest";
import { APP_LOAD_STALL_CODES, appLoadStallCode } from "../app-load-stall";

describe("appLoadStallCode", () => {
  const base = {
    guestRefused: false,
    sessionRefreshFailed: false,
    authenticated: false,
    identityKnown: false,
  };

  it("names the guest-session outcome before the auth state", () => {
    expect(
      appLoadStallCode({ ...base, guestRefused: true, sessionRefreshFailed: true }),
    ).toBe("app_load/guest_session_refused");
    expect(appLoadStallCode({ ...base, sessionRefreshFailed: true })).toBe(
      "app_load/guest_session_failed",
    );
  });

  it("tells waiting for an identity from waiting for the user record", () => {
    expect(appLoadStallCode(base)).toBe("app_load/auth_pending");
    expect(appLoadStallCode({ ...base, authenticated: true })).toBe(
      "app_load/actor_pending",
    );
    expect(
      appLoadStallCode({ ...base, authenticated: true, identityKnown: true }),
    ).toBe("app_load/user_setup_pending");
  });

  it("only returns listed codes", () => {
    for (const guestRefused of [false, true])
      for (const sessionRefreshFailed of [false, true])
        for (const authenticated of [false, true])
          for (const identityKnown of [false, true])
            expect(APP_LOAD_STALL_CODES).toContain(
              appLoadStallCode({
                guestRefused,
                sessionRefreshFailed,
                authenticated,
                identityKnown,
              }),
            );
  });
});
