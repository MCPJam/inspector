import { describe, expect, it } from "vitest";
import {
  describePlatformRefusal,
  PlatformApiError,
  platformRefusalHint,
} from "../../src/platform/index.js";

function refusal429(
  details: Record<string, unknown> | undefined,
  retryAfter?: number
) {
  return new PlatformApiError("Refused.", "RATE_LIMITED", {
    status: 429,
    details,
    retryAfter,
  });
}

describe("describePlatformRefusal", () => {
  it("reads the backend envelope's allowlisted fields", () => {
    expect(
      describePlatformRefusal(
        refusal429(
          {
            code: "generation_rate_limited",
            gatedBy: "burst",
            canTopUp: false,
            isRetryable: true,
            retryAfterMs: 1500,
            error: "free text is not copied",
            organizationId: "org_1",
          },
          undefined
        )
      )
    ).toEqual({
      status: 429,
      code: "RATE_LIMITED",
      reason: "generation_rate_limited",
      gatedBy: "burst",
      canTopUp: false,
      retryable: true,
      // Rounded UP: retrying at the floor retries into the same refusal.
      retryAfterSeconds: 2,
    });
  });

  it("prefers the Retry-After header over the envelope", () => {
    expect(
      describePlatformRefusal(refusal429({ retryAfterMs: 1000 }, 60))
    ).toMatchObject({ retryAfterSeconds: 60 });
  });

  it("drops a reason that is not a plain code", () => {
    expect(
      describePlatformRefusal(refusal429({ code: "<html>proxy error</html>" }))
    ).toEqual({ status: 429, code: "RATE_LIMITED" });
  });

  it("describes a launch its credits cannot fund, on the v1 FORBIDDEN it arrives as", () => {
    const error = new PlatformApiError(
      "Not enough MCPJam credits to start this swarm run.",
      "FORBIDDEN",
      {
        status: 403,
        details: {
          code: "insufficient_credits",
          creditsRequired: 120,
          creditsAvailable: 40,
          maxAffordableSessions: 3,
          resetsAt: 1_790_000_000_000,
          organizationId: "org_1",
        },
      }
    );
    expect(describePlatformRefusal(error)).toEqual({
      status: 403,
      code: "FORBIDDEN",
      reason: "insufficient_credits",
      creditsRequired: 120,
      creditsAvailable: 40,
      maxAffordableSessions: 3,
      resetsAt: 1_790_000_000_000,
    });
  });

  it("describes a bare 402 and drops numbers that are not counts", () => {
    expect(
      describePlatformRefusal(
        new PlatformApiError("Out of credits.", "INTERNAL_ERROR", {
          status: 402,
          details: {
            creditsRequired: "120",
            creditsAvailable: -1,
            maxAffordableSessions: Number.NaN,
            resetsAt: null,
          },
        })
      )
    ).toEqual({ status: 402, code: "INTERNAL_ERROR" });
  });

  it("carries a busy launch's wait", () => {
    expect(
      describePlatformRefusal(
        refusal429({
          code: "spending_reservation_busy",
          isRetryable: true,
          retryAfterMs: 2000,
        })
      )
    ).toEqual({
      status: 429,
      code: "RATE_LIMITED",
      reason: "spending_reservation_busy",
      retryable: true,
      retryAfterSeconds: 2,
    });
  });

  it("is undefined for anything that is not a usage-limit refusal", () => {
    expect(
      describePlatformRefusal(
        new PlatformApiError("Nope.", "FORBIDDEN", { status: 403 })
      )
    ).toBeUndefined();
    // A permission refusal that happens to carry numbers is still not one.
    expect(
      describePlatformRefusal(
        new PlatformApiError("Nope.", "FORBIDDEN", {
          status: 403,
          details: { code: "not_a_member", creditsRequired: 5 },
        })
      )
    ).toBeUndefined();
    expect(describePlatformRefusal(new Error("boom"))).toBeUndefined();
  });
});

describe("platformRefusalHint", () => {
  it("never suggests a top-up, and says credits will not help when told so", () => {
    const hint = platformRefusalHint({
      status: 429,
      code: "RATE_LIMITED",
      canTopUp: false,
      retryAfterSeconds: 30,
    });
    expect(hint).toBe(
      "Retry after 30s, not sooner. This is a usage limit: topping up credits does not lift it."
    );
  });

  it("asks for a wait, not a loop, when no retry time was given", () => {
    expect(platformRefusalHint({ status: 429, code: "RATE_LIMITED" })).toBe(
      "Wait before retrying; do not retry in a loop."
    );
  });

  it("says how far short a launch is, what fits, and when credits refill", () => {
    expect(
      platformRefusalHint({
        status: 403,
        code: "FORBIDDEN",
        reason: "insufficient_credits",
        creditsRequired: 120,
        creditsAvailable: 40,
        maxAffordableSessions: 3,
        resetsAt: Date.UTC(2026, 8, 29),
      })
    ).toBe(
      "It needs about 120 credits and 40 are available. Launch at most 3 sessions instead. Daily credits refill at 2026-09-29T00:00:00.000Z. Retrying the same launch will not help."
    );
    expect(
      platformRefusalHint({
        status: 403,
        code: "FORBIDDEN",
        maxAffordableSessions: 0,
      })
    ).toBe(
      "No sessions fit the available credits. Retrying the same launch will not help."
    );
  });
});
