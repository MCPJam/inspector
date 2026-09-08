import { describe, expect, it } from "vitest";
import { PREDICATE_KINDS } from "@mcpjam/sdk/contract";
import {
  blankPredicate,
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
  it("offer Warn and Report but never Gate", () => {
    for (const kind of PREDICATE_KIND_ORDER) {
      expect(rolesForPredicateKind(kind)).toEqual(
        isObservationPredicateKind(kind)
          ? ["warn", "report"]
          : ["gate", "warn", "report"],
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
