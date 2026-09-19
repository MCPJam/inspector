import { describe, expect, it } from "vitest";
import {
  STANDARD_CHECKS,
  STANDARD_CHECK_NAME_BY_KIND,
} from "../standard-checks.js";
import { STANDARD_CHECK_ASSERTION_KINDS } from "../standard-check-ids.js";

describe("standard check names", () => {
  it("maps each predicate kind to exactly one check", () => {
    const kinds = Object.values(STANDARD_CHECK_ASSERTION_KINDS);
    // The name map is keyed by kind, so a kind claimed by two checks would
    // silently drop one of the two names.
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(Object.keys(STANDARD_CHECK_NAME_BY_KIND).sort()).toEqual(
      [...kinds].sort()
    );
  });

  it("carries the catalog's own name, not a second spelling", () => {
    for (const check of STANDARD_CHECKS) {
      if (check.kind !== "assertion") continue;
      expect(
        STANDARD_CHECK_NAME_BY_KIND[STANDARD_CHECK_ASSERTION_KINDS[check.id]]
      ).toBe(check.name);
    }
  });

  it("names the kinds the scorecard titles rows with", () => {
    expect(STANDARD_CHECK_NAME_BY_KIND.noToolErrors).toBe(
      "Tool errors (isError)"
    );
    expect(STANDARD_CHECK_NAME_BY_KIND.toolCallCountUnder).toBe(
      "Tool hops before the right tool"
    );
  });
});
