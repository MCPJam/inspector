import { describe, expect, it } from "vitest";
import { CI_OWNED_REASON_COPY, isCiOwnedSuite } from "../is-ci-owned-suite";

/**
 * The predicate that decides whether the app may edit a suite at all.
 *
 * It mirrors the platform's own `isCiOwnedSuite`, and the value of a mirror is
 * entirely in matching: a client that locks less than the backend shows buttons
 * that 409, and one that locks more takes an editable suite away from its owner.
 */
describe("isCiOwnedSuite", () => {
  it("locks a suite a file declares", () => {
    // Note the `source`: a file-owned suite is stamped `ui`. Testing
    // `source === "sdk"` alone — which several call sites used to — misses this
    // case entirely, which is the whole reason the predicate exists.
    expect(
      isCiOwnedSuite({ declaredSuiteId: "s_checkout", source: "ui" }),
    ).toBe(true);
  });

  it("locks a suite SDK ingest authored", () => {
    expect(isCiOwnedSuite({ source: "sdk" })).toBe(true);
  });

  it("leaves an app-authored suite alone", () => {
    expect(isCiOwnedSuite({ source: "ui" })).toBe(false);
    expect(isCiOwnedSuite({})).toBe(false);
    expect(isCiOwnedSuite(null)).toBe(false);
    expect(isCiOwnedSuite(undefined)).toBe(false);
  });

  it("ignores an empty declared id rather than reading it as ownership", () => {
    // A blank string is what a partially-migrated row or a bad write leaves
    // behind, and no file can ever name it — so locking on it would strand the
    // suite with no owner and no way back.
    expect(isCiOwnedSuite({ declaredSuiteId: "", source: "ui" })).toBe(false);
  });

  it("does NOT lock a UI suite that CI merely reported a run into", () => {
    // `lastSdkRunAt` is deliberately not part of the rule. Locking on it would
    // take an editable suite away from its author because a pipeline mentioned
    // it once.
    expect(isCiOwnedSuite({ source: "ui", lastSdkRunAt: 1 } as never)).toBe(
      false,
    );
  });
});

describe("CI_OWNED_REASON_COPY", () => {
  it("names both remedies and no permission", () => {
    // Every project member holds `suite.edit` on a CI-owned suite, so a
    // permission-shaped message would send them after access that changes
    // nothing.
    expect(CI_OWNED_REASON_COPY).toMatch(/test file/i);
    expect(CI_OWNED_REASON_COPY).toMatch(/duplicate/i);
    expect(CI_OWNED_REASON_COPY).not.toMatch(/permission/i);
  });
});
