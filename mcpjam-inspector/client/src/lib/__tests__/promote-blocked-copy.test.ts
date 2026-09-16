import { describe, expect, it } from "vitest";

import {
  getPromoteBlockedMessage,
  getPromotionBlockedCopy,
} from "@/lib/promote-blocked-copy";

const FALLBACK = "Failed to load session";

/**
 * The security-relevant unit of BB-247: everything a refused promote shows a
 * user goes through here. It was covered only indirectly through one dialog,
 * which left the branches that decide what NOT to show untested.
 */
describe("getPromoteBlockedMessage", () => {
  it("prefers our copy for a coded refusal", () => {
    expect(
      getPromoteBlockedMessage(
        { data: { code: "SWARM_ATTEMPT_NOT_SUCCEEDED", message: "raw" } },
        FALLBACK,
      ),
    ).toMatch(/did not finish/i);
  });

  it("covers the unattributed code too", () => {
    expect(
      getPromoteBlockedMessage(
        { data: { code: "SWARM_ATTEMPT_UNATTRIBUTED" } },
        FALLBACK,
      ),
    ).toMatch(/not linked to a swarm run/i);
  });

  it("shows a string payload, which the backend writes for a reader", () => {
    expect(
      getPromoteBlockedMessage(
        { data: "Suite is in another project" },
        FALLBACK,
      ),
    ).toBe("Suite is in another project");
  });

  it("truncates a long payload rather than flooding the alert", () => {
    const message = getPromoteBlockedMessage(
      { data: "x".repeat(900) },
      FALLBACK,
    );
    expect(message).toHaveLength(400);
  });

  it.each([
    [
      "a plain Error carrying the server envelope",
      new Error("[CONVEX A(x)] Uncaught Error at handler (../convex/x.ts:1:1)"),
    ],
    ["a payload with no readable message", { data: { code: "UNKNOWN_CODE" } }],
    ["an empty string payload", { data: "   " }],
    ["a non-object throw", "boom"],
    ["null", null],
  ])("falls back for %s", (_label, error) => {
    expect(getPromoteBlockedMessage(error, FALLBACK)).toBe(FALLBACK);
  });

  /**
   * A bare object literal inherits `constructor` from `Object.prototype`, so a
   * truthiness check would return a FUNCTION from a signature promising a
   * string. Unreachable while codes come from the backend's `as const`, but the
   * guard is free.
   */
  it("does not treat an inherited prototype key as a known code", () => {
    expect(
      getPromoteBlockedMessage({ data: { code: "constructor" } }, FALLBACK),
    ).toBe(FALLBACK);
    expect(getPromotionBlockedCopy({ data: { code: "toString" } })).toBeNull();
  });
});

describe("getPromotionBlockedCopy", () => {
  it("returns null for anything it has no code for, so callers can try billing copy", () => {
    expect(
      getPromotionBlockedCopy({ data: { message: "human sentence" } }),
    ).toBeNull();
    expect(getPromotionBlockedCopy(new Error("boom"))).toBeNull();
  });

  it("returns the same copy the load path renders", () => {
    expect(
      getPromotionBlockedCopy({
        data: { code: "SWARM_ATTEMPT_NOT_SUCCEEDED" },
      }),
    ).toBe(
      getPromoteBlockedMessage(
        { data: { code: "SWARM_ATTEMPT_NOT_SUCCEEDED" } },
        FALLBACK,
      ),
    );
  });
});
