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

  it("mints ids that survive a SECOND migration of the same case", () => {
    // The ids used to be `migrated-assert-${i}`, restarting at 0 every call.
    // Migrating a case twice therefore produced two steps sharing an id: React
    // reused the row and `removeStepById` deleted both at once.
    const steps = [{ id: "p", kind: "prompt" as const, prompt: "hi" }];
    const first = appendScenarioPredicatesAsAssertSteps(steps, [
      { type: "noToolErrors" },
    ]);
    const second = appendScenarioPredicatesAsAssertSteps(first, [
      { type: "responseContains", needle: "ok" },
    ]);
    const ids = second.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
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

it("appends at the end even when a legacy case has duplicate step ids", () => {
  const steps = [
    { id: "duplicate", kind: "prompt" as const, prompt: "first" },
    { id: "duplicate", kind: "prompt" as const, prompt: "last" },
  ];
  const result = appendScenarioPredicatesAsAssertSteps(steps, [
    { type: "noToolErrors" },
  ]);
  expect(result.slice(0, 2)).toEqual(steps);
  expect(result[2]).toMatchObject({
    kind: "assert",
    assertion: { type: "noToolErrors" },
  });
});
