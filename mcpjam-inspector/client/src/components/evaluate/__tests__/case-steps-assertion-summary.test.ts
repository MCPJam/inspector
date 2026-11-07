import { describe, expect, it } from "vitest";
import type { Predicate } from "@/shared/eval-matching";
import { WIDGET_ASSERTION_LABELS, type WidgetAssertion } from "@/shared/steps";
import { assertionSummary } from "../case-steps/assertion-summary";

const summary = (assertion: Predicate | WidgetAssertion, inline = true) => {
  const { Icon: _icon, ...rest } = assertionSummary(assertion, inline);
  return rest;
};

describe("assertionSummary", () => {
  it.each<[string, Predicate, Record<string, string>]>([
    [
      "toolCalledWith, any arguments",
      { type: "toolCalledWith", toolName: "read_me", args: { args: {} } },
      {
        label: "Tool was called with",
        value: "read_me",
        extra: "any arguments",
      },
    ],
    [
      "toolCalledWith with arguments",
      {
        type: "toolCalledWith",
        toolName: "create_view",
        args: { args: { a: 1, b: 2 }, argumentMatching: "exact" },
      },
      {
        label: "Tool was called with",
        value: "create_view",
        extra: "2 arguments, exact match",
      },
    ],
    [
      "toolCalledWith blank",
      { type: "toolCalledWith", toolName: "", args: { args: {} } },
      {
        label: "Tool was called with",
        missing: "Fill in the assertion",
        extra: "any arguments",
      },
    ],
    [
      "responseContains",
      { type: "responseContains", needle: "Start" },
      { label: "Response contains", value: "Start" },
    ],
    [
      "responseCloseTo",
      { type: "responseCloseTo", reference: "two boxes", maxDistance: 3 },
      { label: "Response close to", value: "two boxes" },
    ],
    [
      "responseMatches",
      { type: "responseMatches", pattern: "^ok$" },
      { label: "Response matches regex", value: "/^ok$/" },
    ],
    [
      "firstToolWas",
      { type: "firstToolWas", toolName: "read_me" },
      { label: "First tool called was", value: "read_me" },
    ],
  ])("splits a … label: %s", (_name, predicate, expected) => {
    expect(summary(predicate)).toEqual(expected);
  });

  it("reads budget kinds through formatCriterion", () => {
    expect(
      summary({ type: "tokenBudgetUnder", tokens: 250000 }, false),
    ).toEqual({ label: "Token budget under 250000" });
    expect(summary({ type: "turnCountUnder", turns: 3 }, false)).toEqual({
      label: "Fewer than 3 user turns",
    });
  });

  it("uses the inline label for noToolErrors inside a step only", () => {
    expect(summary({ type: "noToolErrors" }, true).label).toBe(
      "No tool errors so far",
    );
    expect(summary({ type: "noToolErrors" }, false).label).toBe(
      "No tool errors",
    );
  });

  it("names the tools of tool-naming kinds", () => {
    expect(summary({ type: "toolNeverCalled", toolName: "rm" })).toEqual({
      label: "Tool was never called",
      value: "rm",
    });
    expect(
      summary({ type: "onlyToolsCalled", toolNames: ["a", "b"] }),
    ).toMatchObject({ value: "a, b" });
    expect(
      summary({ type: "toolCalledBefore", toolName: "a", beforeToolName: "b" }),
    ).toMatchObject({ value: "a → b" });
  });

  it("summarizes widget assertions", () => {
    expect(
      summary({ kind: "textVisible", toolName: "create_view", text: "Start" }),
    ).toEqual({
      label: WIDGET_ASSERTION_LABELS.textVisible,
      value: "Start",
      extra: "in create_view",
    });
    expect(
      summary({ kind: "widgetToolCalled", toolName: "", calledToolName: "x" }),
    ).toMatchObject({ missing: "Pick a view" });
  });
});
