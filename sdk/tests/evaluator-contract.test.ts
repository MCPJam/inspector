/**
 * The canonical evaluator contract, checked against the corpus that already
 * defines the score contract.
 *
 * Two claims, and the second is the one that matters:
 *
 *   1. The projection is a BIJECTION. Every accept row of the shared
 *      score-contract corpus survives a round trip byte for byte. That
 *      direction is not decorative: it is the path a canonical client's payload
 *      travels to reach a reader that predates the vocabulary, and a field
 *      silently dropped in it is a verdict rendered without its reason.
 *   2. The canonical schema accepts and rejects EXACTLY what the score schema
 *      does. It validates by delegation rather than restating the cross-field
 *      rules, so this suite is what proves the delegation actually covers them
 *      — including the load-bearing reject, a row whose `passed` contradicts
 *      its own threshold.
 */

import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/score-contract-parity-fixtures.json" with { type: "json" };
import {
  ASSERTION_KINDS,
  ASSERTION_STAGE,
  EVALUATOR_KINDS,
  EVALUATOR_PRESENTATION_GROUP,
  EVALUATOR_RESULT_SCHEMA_VERSION,
  EVALUATOR_STAGE,
  GRADER_PRESENTATION_GROUP,
  GRADER_STAGE,
  PREDICATE_KINDS,
  PREDICATE_STAGE,
  RECOMMENDED_DEFAULT_ASSERTIONS,
  RECOMMENDED_DEFAULT_PREDICATES,
  evaluatorKindOf,
  evaluatorResultSchema,
  fromEvaluatorResult,
  scoreResultSchema,
  toEvaluatorResult,
} from "../src/contract/index.js";
import type { ScoreResult } from "../src/contract/types.js";

type Row = Record<string, unknown> & { __kind: string; __label: string };
const corpus = fixtures as unknown as { accept: Row[]; reject: Row[] };

/** Strip the fixture's own annotations; every object in the contract is closed. */
function payload(row: Row): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !key.startsWith("__")),
  );
}

const resultRows = (rows: Row[]) => rows.filter((row) => row.__kind === "result");

describe("the evaluator result projects the score contract exactly", () => {
  const accepted = resultRows(corpus.accept);

  it("has result rows to project", () => {
    // A corpus filter that silently matched nothing would make every assertion
    // below vacuously true — the same failure mode as a mirror capture that
    // matches nothing.
    expect(accepted.length).toBeGreaterThan(0);
  });

  for (const row of accepted) {
    it(`round-trips: ${row.__label}`, () => {
      const score = payload(row) as unknown as ScoreResult;
      const projected = toEvaluatorResult(score);
      expect(fromEvaluatorResult(projected)).toEqual(score);
    });
  }

  it("renames exactly four fields and adds exactly two", () => {
    const score = payload(accepted[0]!) as unknown as ScoreResult;
    const projected = toEvaluatorResult(score);

    expect(projected.evaluatorId).toBe(score.scorerId);
    expect(projected.evaluatorVersion).toBe(score.scorerVersion);
    expect(projected.schemaVersion).toBe(EVALUATOR_RESULT_SCHEMA_VERSION);
    expect(EVALUATOR_KINDS).toContain(projected.kind);
    expect(projected).not.toHaveProperty("scorerId");
    expect(projected).not.toHaveProperty("value");
    expect(projected).not.toHaveProperty("rationale");
  });

  it("carries no score on a result that was never scored", () => {
    const score: ScoreResult = {
      scorerId: "judge:goalCompletion",
      scorerVersion: "1",
      definitionHash: "h",
      status: "error",
      passThreshold: 0.7,
      deterministic: false,
      error: "the judge timed out",
    };

    // A fabricated zero would put a defect on the dashboard that nobody
    // observed, and a gating evaluator would fail the iteration on it.
    expect(toEvaluatorResult(score)).not.toHaveProperty("score");
    expect(toEvaluatorResult(score).error).toBe("the judge timed out");
  });
});

describe("the evaluator schema decides what the score schema decides", () => {
  for (const row of resultRows(corpus.accept)) {
    it(`accepts: ${row.__label}`, () => {
      const projected = toEvaluatorResult(payload(row) as unknown as ScoreResult);
      expect(evaluatorResultSchema.safeParse(projected).success).toBe(true);
    });
  }

  for (const row of resultRows(corpus.reject)) {
    it(`rejects: ${row.__label}`, () => {
      const raw = payload(row);
      // The projection is deliberately dumb — it renames, it does not validate
      // — so a corpus reject survives it and must be caught by the schema, not
      // by the projection quietly declining to represent it.
      const projected = {
        schemaVersion: EVALUATOR_RESULT_SCHEMA_VERSION,
        kind: raw.deterministic === false ? "judge" : "assertion",
        ...toEvaluatorResult(raw as unknown as ScoreResult),
      };
      expect(scoreResultSchema.safeParse(raw).success).toBe(false);
      expect(evaluatorResultSchema.safeParse(projected).success).toBe(false);
    });
  }

  it("reports a failure in the caller's own field names", () => {
    const contradiction = {
      schemaVersion: EVALUATOR_RESULT_SCHEMA_VERSION,
      evaluatorId: "e",
      evaluatorVersion: "1",
      definitionHash: "h",
      kind: "assertion" as const,
      status: "scored" as const,
      score: 0.2,
      passThreshold: 0.7,
      passed: true,
      deterministic: true,
    };

    const parsed = evaluatorResultSchema.safeParse(contradiction);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // A caller that sent `score` should not be told about `value` — a field it
    // has never seen in a shape it never used.
    const message = JSON.stringify(parsed.error.issues);
    expect(message).toContain("passed");
    expect(message).not.toContain("`value`");
  });

  it("refuses a kind that contradicts its own determinism", () => {
    const mislabelled = {
      schemaVersion: EVALUATOR_RESULT_SCHEMA_VERSION,
      evaluatorId: "e",
      evaluatorVersion: "1",
      definitionHash: "h",
      kind: "assertion" as const,
      status: "scored" as const,
      score: 0.9,
      passThreshold: 0.7,
      passed: true,
      deterministic: false,
    };

    expect(evaluatorResultSchema.safeParse(mislabelled).success).toBe(false);
  });
});

describe("the evaluator kind is derived, not stored", () => {
  it("calls a deterministic evaluator an assertion and a model one a judge", () => {
    expect(evaluatorKindOf({ deterministic: true })).toBe("assertion");
    expect(evaluatorKindOf({ deterministic: false })).toBe("judge");
  });

  it("has exactly two kinds", () => {
    // Tool matching is an assertion implementation, not a third kind. A
    // presentation variant is a rendering decision and does not belong here.
    expect([...EVALUATOR_KINDS]).toEqual(["assertion", "judge"]);
  });
});

describe("the canonical stage tables are the legacy ones", () => {
  it("re-exports the same objects, not copies of them", () => {
    // `toBe`, not `toEqual`: two tables that merely agree today are two tables
    // that can stop agreeing, and the whole reason this map lives in the
    // contract is that there is only one of it.
    expect(ASSERTION_STAGE).toBe(PREDICATE_STAGE);
    expect(EVALUATOR_STAGE).toBe(GRADER_STAGE);
    expect(EVALUATOR_PRESENTATION_GROUP).toBe(GRADER_PRESENTATION_GROUP);
    expect(ASSERTION_KINDS).toBe(PREDICATE_KINDS);
    expect(RECOMMENDED_DEFAULT_ASSERTIONS).toBe(RECOMMENDED_DEFAULT_PREDICATES);
  });

  it("still files every assertion kind somewhere", () => {
    for (const kind of ASSERTION_KINDS) {
      expect(ASSERTION_STAGE[kind]).toBeDefined();
    }
  });
});
