import { describe, expect, it } from "vitest";
import {
  parseIterationPredicates,
  summarizePredicate,
} from "../predicates-list";
import type { Predicate } from "@/shared/eval-matching";

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

describe("summarizePredicate", () => {
  it("summarizes well-formed variants", () => {
    expect(
      summarizePredicate({ type: "toolCalledAtLeastOnce", toolName: "search" }),
    ).toBe('tool "search" called ≥1×');
    expect(summarizePredicate({ type: "tokenBudgetUnder", tokens: 500 })).toBe(
      "tokens < 500",
    );
    expect(
      summarizePredicate({ type: "responseContains", needle: "refund" }),
    ).toBe('needle "refund"');
    expect(summarizePredicate({ type: "noToolErrors" })).toBe("no tool errors");
  });

  it("degrades to an empty summary instead of throwing on a malformed-but-typed predicate", () => {
    // Valid `type` discriminant but the variant's payload is missing — exactly
    // what `parseIterationPredicates` lets through (it only checks the row
    // envelope). Field access here must not throw during render.
    const malformed: Predicate[] = [
      { type: "tokenBudgetUnder" } as unknown as Predicate, // missing tokens
      { type: "responseContains" } as unknown as Predicate, // missing needle
      { type: "responseMatches" } as unknown as Predicate, // missing pattern
      { type: "toolCalledWith", toolName: "x" } as unknown as Predicate, // missing args
    ];
    for (const p of malformed) {
      expect(() => summarizePredicate(p)).not.toThrow();
      expect(summarizePredicate(p)).toBe("");
    }
  });

  it("returns an empty summary for an unknown future predicate type", () => {
    const future = {
      type: "responseMatchesSemantically",
    } as unknown as Predicate;
    expect(() => summarizePredicate(future)).not.toThrow();
    expect(summarizePredicate(future)).toBe("");
  });

  it("preserves a valid per-turn scope and drops a malformed one", () => {
    const parsed = parseIterationPredicates({
      predicates: [
        {
          predicate: { type: "responseContains", needle: "weather" },
          passed: true,
          reason: "turn 1 contains weather",
          scope: { kind: "turn", promptIndex: 1 },
        },
        {
          predicate: { type: "noToolErrors" },
          passed: true,
          reason: "bad scope dropped, row still case-level",
          scope: { kind: "iteration", promptIndex: 0 },
        },
        {
          predicate: { type: "noToolErrors" },
          passed: true,
          reason: "case level",
        },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed![0].scope).toEqual({ kind: "turn", promptIndex: 1 });
    expect(parsed![1].scope).toBeUndefined();
    expect(parsed![2].scope).toBeUndefined();
  });
});
