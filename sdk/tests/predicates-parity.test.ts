/**
 * Parity test for the predicate Zod schema vs. the hand-mirrored Convex
 * `v.union(...)` in `mcpjam-backend/convex/lib/predicates.ts` (or wherever
 * the backend lands it). The two validators cannot be compared directly
 * because backend tests cannot import `@mcpjam/sdk` (Hard Constraint 1 in
 * the Phase 2 plan: no SDK imports in `convex/`).
 *
 * Instead, both repos load the SAME JSON fixtures file (mirrored at
 * `sdk/tests/fixtures/predicates-parity-fixtures.json` here and at
 * `tests/convex/fixtures/predicates-parity-fixtures.json` in the backend
 * repo) and each side asserts its own validator accepts every `accept`
 * row and rejects every `reject` row. If the two ever drift, both
 * validators will continue to agree internally but diverge from each
 * other — the per-PR check is to keep the two fixture files in lockstep
 * (the README key at the top of the JSON spells this out).
 */

import { describe, it, expect } from "vitest";
import fixtures from "./fixtures/predicates-parity-fixtures.json" with { type: "json" };
import { predicateSchema } from "../src/predicates/types";

type FixtureRow = { label: string; value: unknown };
type FixturesFile = {
  __readme?: string;
  accept: FixtureRow[];
  reject: FixtureRow[];
};

const data = fixtures as FixturesFile;

describe("predicate parity fixtures — Zod (@mcpjam/sdk side)", () => {
  it("fixtures file has both accept and reject cohorts and a README", () => {
    expect(typeof data.__readme).toBe("string");
    expect(Array.isArray(data.accept)).toBe(true);
    expect(Array.isArray(data.reject)).toBe(true);
    expect(data.accept.length).toBeGreaterThan(0);
    expect(data.reject.length).toBeGreaterThan(0);
  });

  it("covers each of the 9 predicate kinds with ≥2 accept examples", () => {
    const kinds = [
      "toolCalledWith",
      "toolCalledAtLeastOnce",
      "toolNeverCalled",
      "firstToolWas",
      "responseContains",
      "responseMatches",
      "noToolErrors",
      "finalAssistantMessageNonEmpty",
      "tokenBudgetUnder",
    ];
    for (const kind of kinds) {
      const matching = data.accept.filter(
        (r) =>
          r.value &&
          typeof r.value === "object" &&
          (r.value as Record<string, unknown>).type === kind,
      );
      expect(
        matching.length,
        `expected ≥2 accept examples for kind "${kind}", got ${matching.length}`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  describe("accept[]", () => {
    for (const row of data.accept) {
      it(`accepts: ${row.label}`, () => {
        const parsed = predicateSchema.safeParse(row.value);
        if (!parsed.success) {
          // Surface zod's error in the message for fast diagnosis.
          throw new Error(
            `Expected accept, got reject for "${row.label}":\n${JSON.stringify(parsed.error.issues, null, 2)}`,
          );
        }
        expect(parsed.success).toBe(true);
      });
    }
  });

  describe("reject[]", () => {
    for (const row of data.reject) {
      it(`rejects: ${row.label}`, () => {
        const parsed = predicateSchema.safeParse(row.value);
        if (parsed.success) {
          throw new Error(
            `Expected reject, got accept for "${row.label}". Parsed value:\n${JSON.stringify(parsed.data, null, 2)}`,
          );
        }
        expect(parsed.success).toBe(false);
      });
    }
  });
});
