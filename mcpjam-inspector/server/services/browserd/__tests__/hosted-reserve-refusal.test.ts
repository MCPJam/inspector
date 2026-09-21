/**
 * What a hosted-browser establishment failure tells the person.
 *
 * Pure, and tested separately from the route for the reason the module itself
 * gives: the mapping is the load-bearing part, it has nine branches, and route
 * tests that stand up a Hono app to check a status code get written once and
 * then not extended.
 */
import { describe, expect, it } from "vitest";
import {
  classifyHostedReserveError,
  httpStatus,
} from "../hosted-reserve-refusal";
import { HostedReserveError } from "../hosted-reserve-error";

describe("classifyHostedReserveError", () => {
  // Every branch, with the status the caller is ANSWERED with beside the
  // status that came in — the two differ on two of them, and a regression that
  // collapsed them all onto one status would otherwise pass.
  for (const [incoming, answered, code] of [
    [401, 401, "hosted-auth-required"],
    [403, 403, "hosted-forbidden"],
    [429, 429, "hosted-at-capacity"],
    [503, 503, "hosted-at-capacity"],
    [504, 504, "hosted-reserve-timeout"],
    [502, 502, "hosted-provision-failed"],
    [410, 409, "hosted-desktop-deleted"],
    [499, 499, "hosted-reserve-abandoned"],
    [0, 503, "hosted-unconfigured"],
  ] as const) {
    it(`maps ${incoming} to ${answered} ${code}`, () => {
      const refusal = classifyHostedReserveError(
        new HostedReserveError("nope", incoming),
      );
      expect(refusal).toMatchObject({ status: answered, code });
      expect(httpStatus(refusal!)).toBe(answered);
      // Every one of these is shown to a person, so every one has to say what
      // happened AND what they can do — not just name a status.
      expect(refusal!.error.length).toBeGreaterThan(20);
    });
  }

  it("carries the control plane's own code without putting it in the message", () => {
    // One 403 covers "this plan does not include Computers" and "the feature
    // is off for this organization". The message says neither on purpose —
    // naming which would leak the org's plan — but an operator still has to be
    // able to tell them apart, so the upstream code rides along for the log.
    const refusal = classifyHostedReserveError(
      new HostedReserveError("nope", 403, "billing_feature_not_included"),
    );
    expect(refusal?.upstreamCode).toBe("billing_feature_not_included");
    expect(refusal?.error).not.toContain("billing_feature_not_included");
  });

  it("omits the upstream code when the control plane sent none", () => {
    const refusal = classifyHostedReserveError(
      new HostedReserveError("nope", 429),
    );
    expect(refusal).not.toHaveProperty("upstreamCode");
  });

  it("returns null for a status it has no mapping for", () => {
    // The caller keeps its own 500-and-report path, which is right for a
    // genuine bug — swallowing one here would hide it.
    expect(
      classifyHostedReserveError(new HostedReserveError("x", 418)),
    ).toBeNull();
  });

  it("returns null for anything that is not a reserve refusal at all", () => {
    expect(classifyHostedReserveError(new Error("something broke"))).toBeNull();
    expect(classifyHostedReserveError("not even an error")).toBeNull();
    expect(classifyHostedReserveError(undefined)).toBeNull();
  });
});
