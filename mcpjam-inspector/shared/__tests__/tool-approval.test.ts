/**
 * `needsApprovalFor` — the whole of the approval policy, in three rows.
 *
 * Small enough that the temptation is to skip it. It is here because the ONE
 * property everything else rests on is not obvious from the implementation:
 * the switch RAISES and can never lower. A future setting that starts letting
 * `requireToolApproval: false` free an `always` tool would satisfy every other
 * test in the repo and be caught only here.
 */
import { describe, expect, it } from "vitest";
import { needsApprovalFor, type ApprovalFloor } from "../tool-approval";

const FLOORS: ApprovalFloor[] = ["never", "setting", "always"];

describe("needsApprovalFor", () => {
  it("never asks at the `never` floor, whatever the switch says", () => {
    expect(needsApprovalFor("never", false)).toBe(false);
    expect(needsApprovalFor("never", true)).toBe(false);
  });

  it("always asks at the `always` floor, whatever the switch says", () => {
    expect(needsApprovalFor("always", false)).toBe(true);
    expect(needsApprovalFor("always", true)).toBe(true);
  });

  it("hands the decision to the switch at the `setting` floor", () => {
    expect(needsApprovalFor("setting", false)).toBe(false);
    expect(needsApprovalFor("setting", true)).toBe(true);
  });

  it("RAISES: turning the switch on never frees a tool", () => {
    for (const floor of FLOORS) {
      const off = needsApprovalFor(floor, false);
      const on = needsApprovalFor(floor, true);
      expect(
        on || !off,
        `${floor} stopped asking when the switch was turned on`,
      ).toBe(true);
    }
  });

  it("returns a real boolean for every floor", () => {
    for (const floor of FLOORS) {
      for (const flag of [true, false]) {
        expect(typeof needsApprovalFor(floor, flag)).toBe("boolean");
      }
    }
  });
});
