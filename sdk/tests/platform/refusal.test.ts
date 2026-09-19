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

  it("is undefined for anything that is not a usage-limit refusal", () => {
    expect(
      describePlatformRefusal(
        new PlatformApiError("Nope.", "FORBIDDEN", { status: 403 })
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
});
