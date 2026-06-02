import { describe, expect, it } from "vitest";
import { shouldShowUserSetupError } from "../user-setup-gate";

describe("shouldShowUserSetupError", () => {
  const authedNoRecord = {
    isHostedChatRoute: false,
    isAuthenticated: true,
    currentUserIsNull: true,
  };

  it("blocks in hosted mode when an authenticated identity has no account record", () => {
    expect(
      shouldShowUserSetupError({ hostedMode: true, ...authedNoRecord }),
    ).toBe(true);
  });

  it("does NOT block in local dev when the account record is missing (inspector#1979 regression)", () => {
    // The app must still boot locally without a backing record, matching
    // pre-#1979 startup behavior.
    expect(
      shouldShowUserSetupError({ hostedMode: false, ...authedNoRecord }),
    ).toBe(false);
  });

  it("does not block when the user is not authenticated", () => {
    expect(
      shouldShowUserSetupError({
        hostedMode: true,
        isHostedChatRoute: false,
        isAuthenticated: false,
        currentUserIsNull: true,
      }),
    ).toBe(false);
  });

  it("does not block when an account record exists", () => {
    expect(
      shouldShowUserSetupError({
        hostedMode: true,
        isHostedChatRoute: false,
        isAuthenticated: true,
        currentUserIsNull: false,
      }),
    ).toBe(false);
  });

  it("does not block on the hosted chat route even with no record", () => {
    expect(
      shouldShowUserSetupError({
        hostedMode: true,
        isHostedChatRoute: true,
        isAuthenticated: true,
        currentUserIsNull: true,
      }),
    ).toBe(false);
  });
});
