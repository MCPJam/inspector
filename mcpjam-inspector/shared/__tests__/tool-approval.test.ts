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
import {
  SYNTHETIC_SESSION_APPROVAL_DENIAL,
  appliedToolApproval,
  engineApprovalMode,
  needsApprovalFor,
  turnApprovalPolicy,
  type ApprovalFloor,
  type ApprovalOrigin,
} from "../tool-approval";

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

/**
 * The per-origin table. Every engine reads it, so a change here changes what
 * Playground, evals, swarms, the API and Events do: a policy change, never a
 * refactor.
 */
describe("turnApprovalPolicy", () => {
  const ORIGINS: ApprovalOrigin[] = ["chat", "eval", "synthetic", "api", "event"];

  it("answers each origin as MCPJam's engine does", () => {
    expect(Object.fromEntries(ORIGINS.map((o) => [o, turnApprovalPolicy(o)])))
      .toEqual({
        chat: { applySwitch: true, answer: "person" },
        eval: { applySwitch: false, answer: "deny" },
        synthetic: { applySwitch: true, answer: "deny" },
        api: { applySwitch: false, answer: "deny" },
        event: { applySwitch: false, answer: "deny" },
      });
  });

  it("keeps the host's switch only where it applies", () => {
    for (const origin of ORIGINS) {
      const { applySwitch } = turnApprovalPolicy(origin);
      expect(appliedToolApproval(origin, true)).toBe(applySwitch);
      expect(appliedToolApproval(origin, false)).toBe(false);
      expect(appliedToolApproval(origin, undefined)).toBe(false);
      // A malformed saved value is off, never on.
      expect(appliedToolApproval(origin, "true")).toBe(false);
    }
  });

  it("pauses for the person only in chat", () => {
    expect(ORIGINS.map((o) => [o, engineApprovalMode(o)])).toEqual([
      ["chat", "prompt"],
      ["eval", "auto-deny"],
      ["synthetic", "auto-deny"],
      ["api", "auto-deny"],
      ["event", "auto-deny"],
    ]);
  });

  it("denies with the engine's synthetic-session result", () => {
    expect(SYNTHETIC_SESSION_APPROVAL_DENIAL).toBe(
      "approval-denied (synthetic session)",
    );
  });
});
