import { describe, expect, it } from "vitest";
import { parseIterationPredicates } from "../predicates-list";

describe("parseIterationPredicates", () => {
  it("returns null when metadata is absent", () => {
    expect(parseIterationPredicates(undefined)).toBeNull();
  });

  it("returns null when metadata has no `predicates` key", () => {
    expect(parseIterationPredicates({ turnCount: 3 })).toBeNull();
  });

  it("returns null when `predicates` is not an array", () => {
    expect(parseIterationPredicates({ predicates: "not-an-array" })).toBeNull();
    expect(parseIterationPredicates({ predicates: { passed: true } })).toBeNull();
  });

  it("returns the rows as PredicateResult[] when well-formed", () => {
    const parsed = parseIterationPredicates({
      predicates: [
        {
          predicate: { type: "toolCalledAtLeastOnce", toolName: "search" },
          passed: true,
          reason: 'tool "search" called 2×',
        },
        {
          predicate: { type: "tokenBudgetUnder", tokens: 500 },
          passed: false,
          reason: "total tokens 643 exceeds budget 500",
        },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed![0].passed).toBe(true);
    expect(parsed![0].predicate.type).toBe("toolCalledAtLeastOnce");
    expect(parsed![1].passed).toBe(false);
    expect(parsed![1].reason).toContain("exceeds budget");
  });

  it("skips malformed rows (missing/wrong-typed fields) without throwing", () => {
    const parsed = parseIterationPredicates({
      predicates: [
        // missing `predicate`
        { passed: true, reason: "fine" },
        // `passed` is not a boolean
        {
          predicate: { type: "noToolErrors" },
          passed: "yes" as unknown as boolean,
          reason: "fine",
        },
        // `predicate.type` missing — discriminant required
        {
          predicate: { toolName: "search" },
          passed: true,
          reason: "fine",
        },
        // valid — survives
        {
          predicate: { type: "noToolErrors" },
          passed: true,
          reason: "no tool errors",
        },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed![0].predicate.type).toBe("noToolErrors");
  });

  it("returns null (hide section) when every row is malformed", () => {
    expect(
      parseIterationPredicates({ predicates: [null, "bad", { passed: true }] }),
    ).toBeNull();
  });

  it("returns null on an empty predicates array (nothing to render)", () => {
    expect(parseIterationPredicates({ predicates: [] })).toBeNull();
  });
});
