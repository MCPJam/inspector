import { describe, expect, test } from "vitest";
import {
  HOSTED_TOOL_MATCH_EVALUATOR_VERSION,
  HOSTED_TOOL_MATCH_SCORER_ID,
  hostedToolMatchScoreDefinition,
} from "../score-definitions.js";
import { buildHostedScoreContract } from "../score-rows.js";
import { canonicalDigest } from "@mcpjam/sdk/contract";

// =============================================================================
// THE `toolCalls:match` DEFINITION'S IDENTITY.
//
// B3b made two changes here that only a digest test can hold in place:
//
//   1. The runner now threads the RESOLVED match options and case polarity into
//      this definition. Before, both were absent from every hosted iteration,
//      so `implementationHash` was computed over `{}` for a scorer that was in
//      fact grading order-agnostic with partial argument matching. If those
//      inputs ever silently stop reaching the digest, the hash goes back to
//      describing a scorer nobody ran — and nothing else would notice.
//   2. `toolMatchAuthored` decoupled the DEFINITION's precondition from the
//      ROW's, so the judge second pass can redeclare the scorer without
//      fabricating a row for a matcher it never ran.
//
// A digest is exactly the kind of thing that breaks quietly, so it is asserted
// by RELATION (same/different) rather than against literals — a literal would
// have to be rewritten on every legitimate version bump, which is how a pin
// becomes a rubber stamp.
// =============================================================================

const digestOf = (args: {
  matchOptions?: Record<string, unknown>;
  isNegativeTest?: boolean;
}) => hostedToolMatchScoreDefinition(args).implementationHash;

describe("resolved match options are part of the definition's identity", () => {
  test("different options ⇒ different digest", () => {
    expect(digestOf({ matchOptions: { ordered: true } })).not.toBe(
      digestOf({ matchOptions: { ordered: false } })
    );
  });

  test("polarity is a hash input — it changes the verdict on an unchanged transcript", () => {
    expect(digestOf({ matchOptions: { ordered: true } })).not.toBe(
      digestOf({ matchOptions: { ordered: true }, isNegativeTest: true })
    );
  });

  test("absent and empty options agree, and are STABLE across calls", () => {
    // They must agree: a case that authored no options and one that resolved to
    // none graded identically, so splitting them would orphan the first pass's
    // row on the second. Stability is the other half — a digest that varied per
    // call would break the join between two passes of the SAME run.
    expect(digestOf({})).toBe(digestOf({ matchOptions: {} }));
    expect(digestOf({})).toBe(digestOf({}));
  });

  test("the digest moves with the evaluator VERSION, which is why the bump exists", () => {
    // Not an assertion about the constant's VALUE — an assertion that the
    // version is an input to the DIGEST. Without it, two runs graded
    // differently would share an `implementationHash` under one
    // `scorerVersion`, and a reader could not tell a fixed projection from a
    // changed scorer.
    //
    // `scorerVersion` carrying the constant is NOT that assertion: the two
    // fields are populated independently, so the digest can stop hashing the
    // version while `scorerVersion` still reports it. Both halves are checked.
    const definition = hostedToolMatchScoreDefinition({});
    expect(definition.scorerVersion).toBe(HOSTED_TOOL_MATCH_EVALUATOR_VERSION);

    // The digest is exactly the canonical payload INCLUDING the version...
    expect(definition.implementationHash).toBe(
      canonicalDigest({
        evaluatorVersion: HOSTED_TOOL_MATCH_EVALUATOR_VERSION,
        matchOptions: {},
      })
    );
    // ...and a different version is a different scorer. This is the half that
    // fails if `evaluatorVersion` is ever dropped from the digest inputs.
    expect(definition.implementationHash).not.toBe(
      canonicalDigest({
        evaluatorVersion: `${HOSTED_TOOL_MATCH_EVALUATOR_VERSION}-other`,
        matchOptions: {},
      })
    );
  });
});

describe("the definition's precondition is not the row's", () => {
  const evaluation = {
    passed: true,
    toolsCalled: [],
    turnCount: 1,
    failedTurnCount: 0,
    expectedToolCalls: ["x"],
    missing: [],
    unexpected: [],
    argumentMismatches: [],
  };

  test("toolMatchAuthored declares the scorer with NO evaluation", () => {
    // The judge second pass's case: it holds the authored case but never ran
    // the matcher. Dropping the definition here left the first pass's row
    // unjoinable and silently removed a GATING scorer from the verdict.
    const { scores, evaluationConfig } = buildHostedScoreContract({
      toolMatchAuthored: true,
    });

    expect(
      evaluationConfig.definitions.map((d) => d.scorerId)
    ).toContain(HOSTED_TOOL_MATCH_SCORER_ID);
    // ...and NO row, because a row is a claim about what the matcher found.
    expect(scores.map((s) => s.scorerId)).not.toContain(
      HOSTED_TOOL_MATCH_SCORER_ID
    );
  });

  test("no evaluation and no toolMatchAuthored ⇒ no such scorer at all", () => {
    // Absence stays absence. A vacuously passing tool-match gate would be
    // invented evidence, and at `enforce` it would be a GATING one.
    const { scores, evaluationConfig } = buildHostedScoreContract({});

    expect(
      evaluationConfig.definitions.map((d) => d.scorerId)
    ).not.toContain(HOSTED_TOOL_MATCH_SCORER_ID);
    expect(scores.map((s) => s.scorerId)).not.toContain(
      HOSTED_TOOL_MATCH_SCORER_ID
    );
  });

  test("an EXPLICIT false is the same as absent", () => {
    // The check is a truthiness test, so `false` already behaves like absent —
    // but that is an implementation detail, and the next person to touch it
    // could reasonably write `!== undefined` and silently declare a gating
    // scorer for every case that passed the flag off. Cheap to pin, and the
    // failure it prevents is a vacuous gate at `enforce`.
    const { scores, evaluationConfig } = buildHostedScoreContract({
      toolMatchAuthored: false,
    });

    expect(evaluationConfig.definitions.map((d) => d.scorerId)).not.toContain(
      HOSTED_TOOL_MATCH_SCORER_ID
    );
    expect(scores.map((s) => s.scorerId)).not.toContain(
      HOSTED_TOOL_MATCH_SCORER_ID
    );
  });

  test("evaluation with authored calls ⇒ both definition AND row", () => {
    const { scores, evaluationConfig } = buildHostedScoreContract({
      evaluation,
    });

    expect(
      evaluationConfig.definitions.map((d) => d.scorerId)
    ).toContain(HOSTED_TOOL_MATCH_SCORER_ID);
    expect(scores.map((s) => s.scorerId)).toContain(
      HOSTED_TOOL_MATCH_SCORER_ID
    );
  });
});
