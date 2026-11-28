import { describe, expect, it } from "vitest";
import { isCiOwnedSuiteDoc } from "../ci-owned-suite.js";

// The predicate now blocks writes, so these pin it to the backend's two
// clauses and keep it from widening.
describe("isCiOwnedSuiteDoc", () => {
  it.each([
    ["a committed suite file", { declaredSuiteId: "s_from_file" }, true],
    ["SDK ingest", { source: "sdk" }, true],
    ["an empty declared id", { declaredSuiteId: "" }, false],
    [
      "a UI suite CI has reported into",
      { source: "ui", lastSdkRunAt: 1_700_000_000_000 },
      false,
    ],
    ["a UI suite", { source: "ui" }, false],
  ])("%s → %s", (_label, suite, expected) => {
    expect(isCiOwnedSuiteDoc(suite)).toBe(expected);
  });
});
