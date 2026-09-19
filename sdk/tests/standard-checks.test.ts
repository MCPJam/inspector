import golden from "./fixtures/standard-checks-golden.json";
import { predicateScorer } from "../src/scorers/predicate-scorer.js";
import { definitionHash } from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import {
  STANDARD_CHECKS,
  ASSERTION_STAGE,
  normalizeSuppressedStandardCheckIds,
  filterSuppressedSuiteAssertions,
} from "../src/contract/index.js";
import { predicateSchema } from "../src/predicates/types.js";

describe("standard check contract", () => {
  it("has unique families and valid advisory presets filed at their reporting stage", () => {
    expect(new Set(STANDARD_CHECKS.map((check) => check.id)).size).toBe(
      STANDARD_CHECKS.length
    );
    expect(new Set(STANDARD_CHECKS.map((check) => check.name)).size).toBe(
      STANDARD_CHECKS.length
    );
    for (const check of STANDARD_CHECKS) expect(check.name.trim()).not.toBe("");
    const assertions = STANDARD_CHECKS.filter(
      (check) => check.kind === "assertion"
    );
    expect(assertions).toHaveLength(15);
    expect(new Set(assertions.map((check) => check.preset.type)).size).toBe(
      assertions.length
    );
    for (const check of assertions) {
      expect(check.name).not.toBe(check.label);
      expect(predicateSchema.parse(check.preset)).toEqual(check.preset);
      expect(ASSERTION_STAGE[check.preset.type]).toBe(check.stage);
      expect(check.preset).toMatchObject({
        role: "advisory",
        severity: "warn",
      });
    }
  });
  it("suppresses all current and later suite rules in a family without content ids", () => {
    const rules = [
      { type: "toolLatencyUnder", ms: 5 },
      { type: "toolLatencyUnder", ms: 999, severity: "warn" },
      { type: "noToolErrors" },
    ];
    expect(
      filterSuppressedSuiteAssertions(rules, ["response.performance"])
    ).toEqual([rules[2]]);
    expect(filterSuppressedSuiteAssertions(rules, undefined)).toEqual(rules);
    expect(normalizeSuppressedStandardCheckIds([])).toBeUndefined();
    expect(
      normalizeSuppressedStandardCheckIds([
        "response.size",
        "response.errors",
        "response.size",
      ])
    ).toEqual(["response.errors", "response.size"]);
    for (const id of [
      "connection.success",
      "userValue.outcome",
      "constructor",
      "unknown",
    ])
      expect(() => normalizeSuppressedStandardCheckIds([id])).toThrow();
    expect(() =>
      normalizeSuppressedStandardCheckIds(Array(65).fill("response.size"))
    ).toThrow();
  });
});

it("pins the new presets without regenerating historical scorer fixtures", () => {
  for (const row of golden) {
    const check = STANDARD_CHECKS.find((check) => check.id === row.id);
    expect(check?.kind).toBe("assertion");
    if (check?.kind !== "assertion") throw new Error("missing check");
    const definition = predicateScorer(check.preset).definition;
    expect(check.preset).toEqual(row.preset);
    expect(definition).toEqual(row.definition);
    expect(definitionHash(definition)).toBe(row.definitionHash);
  }
});
