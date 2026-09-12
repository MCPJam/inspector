/**
 * The projection between the stored score contract and the canonical evaluator
 * result, plus evaluator-named access to the derivation that already exists.
 *
 * Nothing here hashes, finalizes or decides anything. Every function delegates
 * to `derive.ts`, which stays the one place bounds are enforced and `passed` is
 * computed — two implementations of "did this pass" is the failure this whole
 * contract was built to avoid, and adding one here under a nicer name would be
 * the same mistake wearing the new vocabulary.
 */

import {
  errorScoreResult,
  finalizeScoreResult,
  notApplicableScoreResult,
  resolveScoreDefinition,
  skippedScoreResult,
  definitionHash,
  allGatingScorersPassed,
} from "./derive.js";
import {
  EVALUATOR_RESULT_SCHEMA_VERSION,
  evaluatorKindOf,
  type EvaluatorDefinition,
  type EvaluatorRawOutcome,
  type EvaluatorResult,
  type ResolvedEvaluatorDefinition,
} from "./evaluator-types.js";
import type { EvaluationConfigSnapshot, ScoreRawOutcome, ScoreResult } from "./types.js";

/**
 * Project a stored result into the canonical shape.
 *
 * `value → score` and `rationale → explanation` are the only renames; every
 * other field keeps its name and its value. `schemaVersion` and `kind` are
 * added, and {@link fromEvaluatorResult} removes exactly those two again, which
 * is what makes the pair a bijection rather than a lossy convenience.
 *
 * Optional fields are spread conditionally rather than set to `undefined`: a
 * strict validator rejects an explicit `undefined`, and `{ score: undefined }`
 * and `{}` are different documents on the wire even when they are the same
 * object in memory.
 */
export function toEvaluatorResult(score: ScoreResult): EvaluatorResult {
  return {
    schemaVersion: EVALUATOR_RESULT_SCHEMA_VERSION,
    evaluatorId: score.scorerId,
    evaluatorVersion: score.scorerVersion,
    definitionHash: score.definitionHash,
    kind: evaluatorKindOf(score),
    status: score.status,
    ...(score.value !== undefined ? { score: score.value } : {}),
    passThreshold: score.passThreshold,
    ...(score.passed !== undefined ? { passed: score.passed } : {}),
    ...(score.rationale !== undefined ? { explanation: score.rationale } : {}),
    ...(score.evidence !== undefined ? { evidence: score.evidence } : {}),
    deterministic: score.deterministic,
    ...(score.model !== undefined ? { model: score.model } : {}),
    ...(score.promptHash !== undefined ? { promptHash: score.promptHash } : {}),
    ...(score.error !== undefined ? { error: score.error } : {}),
    ...(score.scope !== undefined ? { scope: score.scope } : {}),
  };
}

/**
 * Project a canonical result back to the stored shape.
 *
 * The inverse of {@link toEvaluatorResult}, byte for byte over every accept row
 * of the shared score-contract corpus. It has to be exact rather than
 * approximately right: this is the direction a canonical client's payload
 * travels to reach a reader that predates the vocabulary, and a field silently
 * dropped here is a verdict a dashboard renders without its reason.
 */
export function fromEvaluatorResult(result: EvaluatorResult): ScoreResult {
  return {
    scorerId: result.evaluatorId,
    scorerVersion: result.evaluatorVersion,
    definitionHash: result.definitionHash,
    status: result.status,
    ...(result.score !== undefined ? { value: result.score } : {}),
    passThreshold: result.passThreshold,
    ...(result.passed !== undefined ? { passed: result.passed } : {}),
    ...(result.explanation !== undefined
      ? { rationale: result.explanation }
      : {}),
    ...(result.evidence !== undefined ? { evidence: result.evidence } : {}),
    deterministic: result.deterministic,
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(result.promptHash !== undefined
      ? { promptHash: result.promptHash }
      : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.scope !== undefined ? { scope: result.scope } : {}),
  };
}

/** Project a canonical raw outcome onto the one the finalizer consumes. */
export function toScoreRawOutcome(
  outcome: EvaluatorRawOutcome
): ScoreRawOutcome {
  if (outcome.kind === "scored") {
    return {
      kind: "scored",
      value: outcome.score,
      ...(outcome.explanation !== undefined
        ? { rationale: outcome.explanation }
        : {}),
      ...(outcome.evidence !== undefined ? { evidence: outcome.evidence } : {}),
      ...(outcome.model !== undefined ? { model: outcome.model } : {}),
      ...(outcome.promptHash !== undefined
        ? { promptHash: outcome.promptHash }
        : {}),
      ...(outcome.scope !== undefined ? { scope: outcome.scope } : {}),
    };
  }
  return {
    kind: outcome.kind,
    ...(outcome.explanation !== undefined
      ? { rationale: outcome.explanation }
      : {}),
    ...(outcome.scope !== undefined ? { scope: outcome.scope } : {}),
  };
}

/** Fill in every semantic default, then hash. Delegates; does not re-derive. */
export function resolveEvaluatorDefinition(
  definition: EvaluatorDefinition
): ResolvedEvaluatorDefinition {
  return resolveScoreDefinition(definition);
}

/** The definition digest. The payload is unchanged — see `derive.ts`. */
export function evaluatorDefinitionHash(
  definition: ResolvedEvaluatorDefinition
): string {
  return definitionHash(definition);
}

/** The only sanctioned producer of a scored result, in canonical shape. */
export function finalizeEvaluatorResult(
  definition: ResolvedEvaluatorDefinition,
  outcome: EvaluatorRawOutcome
): EvaluatorResult {
  return toEvaluatorResult(
    finalizeScoreResult(definition, toScoreRawOutcome(outcome))
  );
}

/** An evaluator that could not be scored. Carries no `score`, by contract. */
export function errorEvaluatorResult(
  definition: ResolvedEvaluatorDefinition,
  error: unknown,
  options?: { scope?: EvaluatorResult["scope"] }
): EvaluatorResult {
  return toEvaluatorResult(errorScoreResult(definition, error, options));
}

/** An evaluator that did not run. */
export function skippedEvaluatorResult(
  definition: ResolvedEvaluatorDefinition,
  explanation?: string,
  options?: { scope?: EvaluatorResult["scope"] }
): EvaluatorResult {
  return toEvaluatorResult(
    skippedScoreResult(definition, explanation, options)
  );
}

/** An evaluator that does not apply to this iteration at all. */
export function notApplicableEvaluatorResult(
  definition: ResolvedEvaluatorDefinition,
  explanation?: string,
  options?: { scope?: EvaluatorResult["scope"] }
): EvaluatorResult {
  return toEvaluatorResult(
    notApplicableScoreResult(definition, explanation, options)
  );
}

/**
 * Did every gating evaluator hold?
 *
 * Accepts either shape so a caller mid-migration does not have to convert a
 * list before asking the question — but the answer comes from the same
 * derivation either way, because the alternative is two implementations of the
 * gate and a way for them to disagree.
 */
export function allGatingEvaluatorsPassed(
  results: ReadonlyArray<EvaluatorResult | ScoreResult>,
  config: EvaluationConfigSnapshot
): ReturnType<typeof allGatingScorersPassed> {
  const scores = results.map((row) =>
    "evaluatorId" in row ? fromEvaluatorResult(row) : row
  );
  return allGatingScorersPassed(scores, config);
}
