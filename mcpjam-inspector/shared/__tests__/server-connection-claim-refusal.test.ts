/**
 * The claim-refusal vocabulary shared by the web route and the handoff page.
 *
 * The fallback arms matter more than the happy path here. An unrecognized code
 * must produce "not a refusal" rather than a guess, because a guess sends a
 * signed-out visitor down the switch-accounts branch — the exact wrong turn
 * this vocabulary was introduced to remove.
 */

import { describe, expect, it } from "vitest";
import {
  claimRefusalReason,
  readClaimRefusal,
} from "../server-connection-claim-refusal";

describe("claimRefusalReason", () => {
  it("maps the backend's two refusal codes", () => {
    expect(claimRefusalReason("SIGN_IN_REQUIRED")).toBe("sign-in-required");
    expect(claimRefusalReason("ACCOUNT_MISMATCH")).toBe("account-mismatch");
  });

  it.each([
    ["FORBIDDEN", "the code a backend predating the split still returns"],
    ["REQUEST_NOT_FOUND", "an unrelated flow code"],
    [undefined, "no code at all"],
    ["", "an empty code"],
    ["sign-in-required", "the reason spelled as if it were the code"],
  ])("returns undefined for %j (%s)", (code, _why) => {
    expect(claimRefusalReason(code as string | undefined)).toBeUndefined();
  });

  it("does not inherit from Object.prototype", () => {
    // The map is indexed by an attacker-adjacent string. `constructor` and
    // `toString` are on every object literal's prototype chain, and returning
    // one of those as a "reason" would put a function where the page expects a
    // union member.
    expect(claimRefusalReason("constructor")).toBeUndefined();
    expect(claimRefusalReason("toString")).toBeUndefined();
    expect(claimRefusalReason("__proto__")).toBeUndefined();
  });
});

describe("readClaimRefusal", () => {
  it("reads a reason with its owner hint", () => {
    expect(
      readClaimRefusal({ reason: "account-mismatch", ownerHint: "m•••@x.com" })
    ).toEqual({ reason: "account-mismatch", ownerHint: "m•••@x.com" });
  });

  it("reads a reason with no owner hint", () => {
    expect(readClaimRefusal({ reason: "sign-in-required" })).toEqual({
      reason: "sign-in-required",
    });
  });

  it.each([
    [undefined],
    [null],
    ["account-mismatch"],
    [42],
    [{}],
    [{ reason: "something-else" }],
    [{ reason: 7 }],
  ])("returns null for %j", (details) => {
    expect(readClaimRefusal(details)).toBeNull();
  });

  it("drops an owner hint that is not a non-empty string", () => {
    // It is rendered directly at the user; `undefined` on screen is worse than
    // the generic sentence the page falls back to.
    for (const ownerHint of [null, "", 42, {}]) {
      expect(
        readClaimRefusal({ reason: "account-mismatch", ownerHint })
      ).toEqual({ reason: "account-mismatch" });
    }
  });
});
