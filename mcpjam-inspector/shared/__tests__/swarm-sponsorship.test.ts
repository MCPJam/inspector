import { describe, expect, it } from "vitest";
import {
  parseFundingChangedDetails,
  parseFundingSummary,
  parseSessionFunding,
  SPONSORED_CAPACITY_MESSAGE,
  SPONSORSHIP_REJECTED_MESSAGE,
  sponsoredPlatformFailure,
} from "../swarm-sponsorship";
import { isCreditExhaustion } from "../credit-exhaustion";

describe("sponsoredPlatformFailure", () => {
  it.each([
    ["platform_capacity", "platform_capacity"],
    ["platform_generation_unavailable", "platform_capacity"],
    ["platform_free_budget_exhausted", "platform_capacity"],
    ["swarm_sponsorship_rejected", "swarm_sponsorship_rejected"],
    ["sponsorship_rejected", "swarm_sponsorship_rejected"],
    ["agent_billing_rejected", "swarm_sponsorship_rejected"],
  ])("reads the code %s", (code, expected) => {
    expect(sponsoredPlatformFailure({ code })?.code).toBe(expected);
  });

  it("reads the code out of the runner's wire message", () => {
    expect(
      sponsoredPlatformFailure({
        message: "Capacity is exhausted (platform_capacity, HTTP 429)",
      }),
    ).toEqual({
      code: "platform_capacity",
      message: SPONSORED_CAPACITY_MESSAGE,
    });
    expect(
      sponsoredPlatformFailure({
        message:
          'swarm-agent x failed (403): {"code":"swarm_sponsorship_rejected"}',
      })?.message,
    ).toBe(SPONSORSHIP_REJECTED_MESSAGE);
  });

  it("ignores ordinary failures and org credit exhaustion", () => {
    expect(
      sponsoredPlatformFailure({ message: "Tool timed out" }),
    ).toBeUndefined();
    expect(
      sponsoredPlatformFailure({
        code: "user_rate_limit",
        message: "Daily credit limit reached. (user_rate_limit, HTTP 429)",
      }),
    ).toBeUndefined();
    expect(sponsoredPlatformFailure({})).toBeUndefined();
  });

  it("never sells credits or claims guarantees in its copy, and is not a credit-exhaustion signal", () => {
    for (const message of [
      SPONSORED_CAPACITY_MESSAGE,
      SPONSORSHIP_REJECTED_MESSAGE,
    ]) {
      expect(message).not.toMatch(/upgrade|top.?up|buy|free|guarantee/i);
      expect(isCreditExhaustion(message)).toBe(false);
    }
    expect(isCreditExhaustion("(platform_capacity, HTTP 429)")).toBe(false);
  });
});

describe("funding parsers", () => {
  it("accepts only whole non-negative counts", () => {
    expect(parseFundingSummary({ sponsored: 1, credits: 2, total: 3 })).toEqual(
      {
        sponsored: 1,
        credits: 2,
        total: 3,
      },
    );
    expect(
      parseFundingSummary({ sponsored: -1, credits: 2, total: 3 }),
    ).toBeUndefined();
    expect(
      parseFundingSummary({ sponsored: 1.5, credits: 2, total: 3 }),
    ).toBeUndefined();
    expect(parseFundingSummary("x")).toBeUndefined();
  });

  it("keeps well-formed session entries in order and drops the rest", () => {
    expect(
      parseSessionFunding([
        { targetId: "a", sessionIdx: 0, funding: "starter" },
        { targetId: 1, sessionIdx: 0, funding: "starter" },
        { targetId: "a", sessionIdx: 1, funding: "credits" },
        null,
      ]),
    ).toEqual([
      { targetId: "a", sessionIdx: 0, funding: "starter" },
      { targetId: "a", sessionIdx: 1, funding: "credits" },
    ]);
    expect(parseSessionFunding(undefined)).toEqual([]);
  });

  it("parses the swarm_funding_changed details", () => {
    expect(
      parseFundingChangedDetails({
        expectedSponsored: 5,
        actualSponsored: 3,
        totalConversations: 15,
        code: "swarm_funding_changed",
      }),
    ).toEqual({
      expectedSponsored: 5,
      actualSponsored: 3,
      totalConversations: 15,
    });
    expect(
      parseFundingChangedDetails({ expectedSponsored: 5 }),
    ).toBeUndefined();
  });
});
