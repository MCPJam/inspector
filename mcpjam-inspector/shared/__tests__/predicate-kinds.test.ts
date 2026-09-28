import { describe, expect, it } from "vitest";
import { PREDICATE_KINDS } from "@mcpjam/sdk/contract";
import {
  blankPredicate,
  formatCriterion,
  GLOBAL_GATE_CATALOG,
  globalGateDescription,
  globalGateDetail,
  globalGateLabel,
  isGlobalPolicyKind,
  isObservationPredicateKind,
  PREDICATE_KIND_LABELS,
  PREDICATE_KIND_ORDER,
  rolesForPredicateKind,
} from "../predicate-kinds";

describe("global gate catalog", () => {
  it("defines labels, descriptions, and details for every policy menu kind", () => {
    for (const entry of GLOBAL_GATE_CATALOG) {
      expect(isGlobalPolicyKind(entry.kind)).toBe(true);
      expect(globalGateLabel(entry.kind)).toBe(entry.label);
      expect(globalGateDescription(entry.kind)).toBe(entry.description);
      expect(globalGateDetail(entry.kind)).toBe(entry.detail);
    }
  });
});

describe("PREDICATE_KIND_ORDER", () => {
  // A HAND LIST, unlike `PREDICATE_KIND_LABELS` which the compiler forces to be
  // total. A kind missing from the order simply never appears in the menu that
  // renders from it — a scorer nobody can add, with no error anywhere.
  it("lists every kind exactly once", () => {
    expect([...PREDICATE_KIND_ORDER].sort()).toEqual(
      [...(PREDICATE_KINDS as readonly string[])].sort(),
    );
    expect(new Set(PREDICATE_KIND_ORDER).size).toBe(PREDICATE_KIND_ORDER.length);
  });

  it("labels every kind", () => {
    for (const kind of PREDICATE_KIND_ORDER) {
      expect(PREDICATE_KIND_LABELS[kind]).toBeTruthy();
    }
  });
});

describe("observation kinds", () => {
  it("offer Advisory but never Required", () => {
    for (const kind of PREDICATE_KIND_ORDER) {
      expect(rolesForPredicateKind(kind)).toEqual(
        isObservationPredicateKind(kind)
          ? ["advisory"]
          : ["required", "advisory"],
      );
    }
  });

  it("seed advisory, because the schema refuses a gating one", () => {
    for (const kind of PREDICATE_KIND_ORDER) {
      if (!isObservationPredicateKind(kind)) continue;
      expect(blankPredicate(kind).role).toBe("advisory");
    }
  });
});

describe("toolArgumentsMatch", () => {
  it("seeds one empty pattern and writes no defaults", () => {
    // The predicate is the criterion's identity: a blank that wrote `min: 1`
    // or a flag would mint a different id from the same check authored
    // anywhere that omits them.
    expect(blankPredicate("toolArgumentsMatch")).toEqual({
      type: "toolArgumentsMatch",
      toolName: "",
      patterns: [""],
    });
  });

  it("formats a counting-exact sentence", () => {
    const format = (over: object) =>
      formatCriterion({
        predicate: {
          type: "toolArgumentsMatch",
          toolName: "create_view",
          patterns: ["Idea", "Build", "Ship"],
          ...over,
        } as never,
      });
    expect(format({ flags: "i" })).toBe(
      "At least 1 matching call(s) to create_view whose arguments match all of /Idea/i, /Build/i, /Ship/i",
    );
    expect(format({ patterns: ["Idea"], argument: "elements" })).toBe(
      'At least 1 matching call(s) to create_view whose "elements" argument matches /Idea/',
    );
    expect(format({ min: 2, max: 2 })).toMatch(/^Exactly 2 matching call/);
    // `0/0` is "no call matches", never "never called".
    const none = format({ patterns: ["secret"], min: 0, max: 0 });
    expect(none).toBe(
      "No matching call to create_view whose arguments match /secret/",
    );
    expect(none).not.toMatch(/never/i);
  });

  it("falls back to the kind label for a row missing its patterns", () => {
    expect(
      formatCriterion({
        predicate: { type: "toolArgumentsMatch", toolName: "x" } as never,
      }),
    ).toBe("Tool arguments match pattern(s) (x)");
  });
});
