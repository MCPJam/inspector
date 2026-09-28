import { describe, expect, it } from "vitest";
import { CI_OWNED_REASON_COPY, isCiOwnedSuite } from "../is-ci-owned-suite";

/**
 * The predicate the whole client lock rests on.
 *
 * Two ways to be CI-owned, one way NOT to be, and the third is the one worth
 * pinning: CI reporting a result *into* a suite does not make that suite CI's.
 */
describe("isCiOwnedSuite", () => {
  it("is true for a suite declared by a committed file", () => {
    // The file's sync hard-deletes any case it does not name, so an edit here
    // survives exactly until the next CI run.
    expect(isCiOwnedSuite({ declaredSuiteId: "s_refunds" })).toBe(true);
  });

  it("is true for a suite created by SDK ingest", () => {
    // Its cases are synthesized from run reports; editing them changes nothing
    // about what CI runs.
    expect(isCiOwnedSuite({ source: "sdk" })).toBe(true);
  });

  it("is FALSE for an app suite that CI merely reports into", () => {
    // The failure this rules out: locking on "has CI runs" would take a working
    // surface away from the person who built the suite.
    expect(isCiOwnedSuite({ source: "ui" })).toBe(false);
    expect(isCiOwnedSuite({ source: "ui", declaredSuiteId: "" })).toBe(false);
  });

  it("is false for anything missing or empty", () => {
    expect(isCiOwnedSuite(null)).toBe(false);
    expect(isCiOwnedSuite(undefined)).toBe(false);
    // A backend that predates the field sends neither key.
    expect(isCiOwnedSuite({})).toBe(false);
  });

  it("names both ways forward in its copy", () => {
    // A reader who gets only "no" has no next move, and the two remedies are
    // genuinely different: the file keeps the suite's history and CI wiring, a
    // duplicate gives both up for an editable copy.
    expect(CI_OWNED_REASON_COPY).toMatch(/test file/i);
    expect(CI_OWNED_REASON_COPY).toMatch(/duplicate/i);
  });
});
