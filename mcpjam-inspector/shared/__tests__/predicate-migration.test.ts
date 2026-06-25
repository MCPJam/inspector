import { describe, expect, it } from "vitest";
import {
  appendScenarioPredicatesAsAssertSteps,
  splitPredicatesForMigration,
  stripScenarioPredicatesFromList,
} from "@/shared/predicate-migration";
import type { Predicate } from "@/shared/eval-matching";

describe("splitPredicatesForMigration", () => {
  it("puts tokenBudgetUnder in global gates", () => {
    const preds: Predicate[] = [
      { type: "tokenBudgetUnder", tokens: 500 },
      { type: "responseContains", needle: "ok" },
    ];
    const { globalGates, scenarioAsserts } = splitPredicatesForMigration(preds);
    expect(globalGates).toEqual([{ type: "tokenBudgetUnder", tokens: 500 }]);
    expect(scenarioAsserts).toEqual([
      { type: "responseContains", needle: "ok" },
    ]);
  });

  it("classifies turn-scopable kinds as scenario asserts", () => {
    const preds: Predicate[] = [
      { type: "noToolErrors" },
      { type: "toolCalledWith", toolName: "search", args: { args: {} } },
    ];
    const { globalGates, scenarioAsserts } = splitPredicatesForMigration(preds);
    expect(globalGates).toEqual([]);
    expect(scenarioAsserts).toHaveLength(2);
  });
});

describe("appendScenarioPredicatesAsAssertSteps", () => {
  it("appends assert steps at the end preserving order", () => {
    const steps = [{ id: "p", kind: "prompt" as const, prompt: "hi" }];
    const asserts: Predicate[] = [
      { type: "responseContains", needle: "ok" },
      { type: "noToolErrors" },
    ];
    const next = appendScenarioPredicatesAsAssertSteps(steps, asserts);
    expect(next).toHaveLength(3);
    expect(next[1]?.kind).toBe("assert");
    expect(next[2]?.kind).toBe("assert");
  });
});

describe("stripScenarioPredicatesFromList", () => {
  it("removes scenario asserts and keeps global gates", () => {
    const preds: Predicate[] = [
      { type: "tokenBudgetUnder", tokens: 100 },
      { type: "responseContains", needle: "x" },
    ];
    expect(stripScenarioPredicatesFromList(preds)).toEqual([
      { type: "tokenBudgetUnder", tokens: 100 },
    ]);
  });
});
