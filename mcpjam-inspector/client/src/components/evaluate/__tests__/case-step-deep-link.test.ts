import { describe, expect, it } from "vitest";
import type { TestStep } from "@/shared/steps";
import { readCaseStepParam } from "../case-steps/case-step-deep-link";

const steps: TestStep[] = [
  { id: "p1", kind: "prompt", prompt: "Hi" },
  { id: "a2", kind: "assert", assertion: { type: "noToolErrors" } },
];

describe("readCaseStepParam", () => {
  it.each([
    ["?step=action%3Ap1", "action:p1"],
    ["?step=check%3Aa2", "check:a2"],
    ["?step=outcome", "outcome"],
    ["?step=after-run", "after-run"],
  ])("accepts %s", (search, key) => {
    expect(readCaseStepParam(search, steps)).toBe(key);
  });

  it.each([
    ["", "missing param"],
    ["?step=", "empty"],
    ["?step=check%3Anope", "unknown id"],
    ["?step=check%3Ap1", "check on a step"],
    ["?step=action%3Aa2", "action on an assertion"],
    ["?step=route", "not a preview key"],
    ["?step=weird%3Ap1", "unknown kind"],
  ])("rejects %s (%s)", (search) => {
    expect(readCaseStepParam(search, steps)).toBeNull();
  });
});
