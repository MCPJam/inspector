/**
 * The client half of the backend's `sign_in_required` contract.
 *
 * Five backend doors onto platform-paid lanes refuse an anonymous caller with
 * one shared code, precisely so the Inspector classifies it once. What makes
 * that fragile is the transport: `err.data` does not survive every path a
 * rejection takes to a hook, and Convex prefixes `Server Error` onto mutation
 * rejections — which is what used to send these refusals down the generic
 * branch and hide the whole surface from the one reader who could fix it in a
 * click.
 */
import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  isSignInRequired,
  signInRequiredMessage,
  SIGN_IN_REQUIRED_CODE,
} from "@/lib/sign-in-required";

describe("signInRequiredMessage", () => {
  it("reads the refusal's own copy off structured ConvexError data", () => {
    const err = new ConvexError({
      code: SIGN_IN_REQUIRED_CODE,
      feature: "run insights",
      message: "Sign in to keep going.",
    });
    expect(signInRequiredMessage(err)).toBe("Sign in to keep going.");
  });

  it("still reads it when only the stringified payload survived", () => {
    // The shape a hook actually sees through Convex's mutation boundary.
    const err = new Error(
      '[CONVEX M(runInsights:requestRunInsights)] Server Error ' +
        `{"code":"${SIGN_IN_REQUIRED_CODE}","feature":"run insights",` +
        '"message":"You\'ve reached today\'s limit for AI insights."}',
    );
    expect(signInRequiredMessage(err)).toBe(
      "You've reached today's limit for AI insights.",
    );
  });

  it("falls back to generic copy when the code arrives without a message", () => {
    const err = new Error(`refused: ${SIGN_IN_REQUIRED_CODE}`);
    expect(signInRequiredMessage(err)).toBe("Sign in to use this.");
  });

  it("is null for every other refusal", () => {
    // The ones that must NOT be mistaken for this: a rate limit is a wait, a
    // permission refusal is about a workspace rather than an account, and a
    // flagged-off feature is not something the reader can act on at all.
    for (const other of [
      new ConvexError({ code: "rate_limited", message: "Wait a moment." }),
      new ConvexError({ code: "FEATURE_UNAVAILABLE", message: "Not for you." }),
      new Error("Not a member of this workspace"),
      new Error("Could not find public function"),
    ]) {
      expect(signInRequiredMessage(other), String(other)).toBeNull();
      expect(isSignInRequired(other)).toBe(false);
    }
  });

  it("does not throw on a non-Error rejection", () => {
    expect(signInRequiredMessage(undefined)).toBeNull();
    expect(signInRequiredMessage("boom")).toBeNull();
    expect(signInRequiredMessage({ nope: true })).toBeNull();
  });
});
