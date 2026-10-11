import { describe, expect, it } from "vitest";
import {
  parseFundingChangedDetails,
  parseFundingSummary,
  parseSessionFunding,
  SPONSORED_CAPACITY_MESSAGE,
  SPONSORSHIP_REJECTED_MESSAGE,
  SPONSORSHIP_UNCONFIRMED_MESSAGE,
  sponsoredPlatformFailure,
  unstartedSponsoredStopMessage,
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

  // The backend's own refusals (403/409) guarantee the step never reached a
  // customer rail. `agent_billing_rejected` does not: the stream handler raises
  // it for a 404 (nothing ran) AND for a platform answer that came back without
  // the paid confirmation, which had already admitted the step. The stored copy
  // cannot tell them apart, so it must not assert "not charged" for it.
  it("does not claim nothing was charged when the platform confirmation was missing", () => {
    for (const input of [
      { code: "agent_billing_rejected" },
      {
        message:
          "This MCPJam deployment did not confirm that the turn was billed to MCPJam, so Ask MCPJam stopped. (agent_billing_rejected, HTTP 503)",
      },
    ]) {
      const failure = sponsoredPlatformFailure(input);
      expect(failure?.code).toBe("swarm_sponsorship_rejected");
      expect(failure?.message).toBe(SPONSORSHIP_UNCONFIRMED_MESSAGE);
    }
    expect(SPONSORSHIP_UNCONFIRMED_MESSAGE).not.toMatch(
      /\bnot charged\b|\bwasn't charged\b|\bnothing was charged\b/i,
    );
    expect(SPONSORSHIP_UNCONFIRMED_MESSAGE).toMatch(/contact support/i);
  });

  it("still says an explicit backend refusal was not charged", () => {
    for (const code of ["swarm_sponsorship_rejected", "sponsorship_rejected"]) {
      expect(sponsoredPlatformFailure({ code })?.message).toBe(
        SPONSORSHIP_REJECTED_MESSAGE,
      );
    }
    expect(SPONSORSHIP_REJECTED_MESSAGE).toMatch(/not charged/i);
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
      SPONSORSHIP_UNCONFIRMED_MESSAGE,
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

describe("unstartedSponsoredStopMessage", () => {
  it("says nothing was charged for a conversation an unconfirmed stop swept before it started", () => {
    const stop = sponsoredPlatformFailure({ code: "agent_billing_rejected" })!;
    expect(stop.message).toBe(SPONSORSHIP_UNCONFIRMED_MESSAGE);
    expect(unstartedSponsoredStopMessage(stop)).toBe(
      SPONSORSHIP_REJECTED_MESSAGE,
    );
    expect(unstartedSponsoredStopMessage(stop)).not.toMatch(/contact support/i);
  });

  it("leaves every other stop's sentence alone", () => {
    for (const code of ["platform_capacity", "swarm_sponsorship_rejected"]) {
      const stop = sponsoredPlatformFailure({ code })!;
      expect(unstartedSponsoredStopMessage(stop)).toBe(stop.message);
    }
  });
});
