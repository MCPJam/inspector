import type { AuthChallengeSignal } from "@mcpjam/sdk/browser";
import { describe, expect, it } from "vitest";
import {
  isSignInChallengeError,
  passthroughChallengeErrorText,
} from "../auth-challenge-error";
import type { AuthChallengePresentation } from "../auth-challenge-lifecycle";

const FACETS = {
  challengeHeader: "bearer",
  hasResourceMetadata: false,
  hasScope: false,
  hasErrorParams: false,
} as const;

function signal(
  overrides: Partial<AuthChallengeSignal> = {},
): AuthChallengeSignal {
  return {
    source: "http_401",
    effectiveAuth: "discover",
    facets: FACETS,
    ...overrides,
  } as AuthChallengeSignal;
}

const PASSTHROUGH = {
  kind: "notice",
  reason: "passthrough",
  message: "The selected host ignores this challenge.",
} as AuthChallengePresentation;

describe("passthroughChallengeErrorText", () => {
  it.each([
    [undefined, "The server asked for sign-in, so the call failed."],
    [
      "Sign in",
      "The server asked for sign-in, so the call failed. The server said: Sign in.",
    ],
    [
      "Sign in.",
      "The server asked for sign-in, so the call failed. The server said: Sign in.",
    ],
  ])(
    "says the call failed for description %j",
    (errorDescription, expected) => {
      expect(
        passthroughChallengeErrorText(
          PASSTHROUGH,
          signal({ errorDescription }),
        ),
      ).toBe(expected);
    },
  );

  it("leaves a _meta challenge to the completed result", () => {
    expect(
      passthroughChallengeErrorText(
        PASSTHROUGH,
        signal({ source: "tool_result_meta" }),
      ),
    ).toBeNull();
  });

  it("adds nothing when the host shows a card", () => {
    expect(
      passthroughChallengeErrorText(
        { kind: "ignored" } as AuthChallengePresentation,
        signal(),
      ),
    ).toBeNull();
  });
});

describe("isSignInChallengeError", () => {
  it("is false for an error without a challenge", () => {
    expect(isSignInChallengeError(new Error("boom"))).toBe(false);
  });

  it("is true for a sign-in challenge, which the card replaces", () => {
    expect(
      isSignInChallengeError({ details: { authChallenge: signal() } }),
    ).toBe(true);
  });

  it("keeps the error for a scope step-up", () => {
    expect(
      isSignInChallengeError({
        details: {
          authChallenge: signal({ source: "http_403_insufficient_scope" }),
        },
      }),
    ).toBe(false);
  });
});
