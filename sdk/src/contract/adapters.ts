/**
 * Pure mappers from every legacy verdict source into the one contract shape.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * Scoring is not a fifth verdict system beside `test()`, the tool-call matcher,
 * predicates and judges — it is the shape those four are projected into. These
 * adapters are that projection, and keeping them pure (no evaluation, no I/O)
 * is what lets the runner evaluate ONCE and emit two views: the legacy compat
 * field and the score row, which therefore cannot disagree.
 *
 * Each source contributes both halves: a `*ScoreDefinition` builder (what the
 * scorer is, including the `implementationHash` derived from its real config)
 * and a `from*` result mapper.
 */

import type { EvalMatchOptions, EvalToolCallMatchResult } from "../matchers.js";
import type { EvalExpectedToolCall } from "../eval-reporting-types.js";
import type { Predicate, PredicateResult } from "../predicates/types.js";
import { canonicalDigest } from "./canonical.js";
import { finalizeScoreResult } from "./derive.js";
import {
  PREDICATES_VERSION,
  type ResolvedScoreDefinition,
  type ScoreDefinition,
  type ScorerRole,
  type ScoreResult,
} from "./types.js";

/** Stable id of the scorer that projects `config.expectedToolCalls`. */
export const TOOL_MATCH_SCORER_ID = "tool-match";
/** Stable id of the scorer that projects the legacy `test()` boolean. */
export const LEGACY_TEST_SCORER_ID = "legacy:test";
/** Version of the legacy-boolean projection itself. */
export const LEGACY_TEST_VERSION = "1";
/** Version of the tool-match projection; tracks the matcher's semantics. */
export const TOOL_MATCH_VERSION = "1";

/**
 * Positional id minted for a predicate the author did not name.
 *
 * UNSTABLE by construction — inserting a predicate above index 2 renumbers it —
 * which is why the definition records `idSource: "generated"` and why gates
 * refuse to select one. Anything gated in CI needs an explicit id.
 */
export function generatedPredicateScorerId(
  predicate: Predicate,
  ordinal: number
): string {
  return `predicate:${predicate.type}#${ordinal}`;
}

/**
 * The definition for one authored predicate.
 *
 * `implementationHash` is the canonicalized predicate itself: editing
 * `responseContains "refund issued"` to `"refund processed"` changes what the
 * scorer does, so it must change the evaluation config hash even though the
 * scorer id, version and threshold are untouched.
 */
export function predicateScoreDefinition(
  predicate: Predicate,
  options: { id?: string; ordinal: number; role?: ScorerRole }
): ScoreDefinition {
  const explicit = options.id?.trim();
  return {
    scorerId: explicit || generatedPredicateScorerId(predicate, options.ordinal),
    idSource: explicit ? "explicit" : "generated",
    scorerVersion: PREDICATES_VERSION,
    implementationHash: canonicalDigest(predicate),
    label: predicate.type,
    deterministic: true,
    passThreshold: 1,
    role: options.role ?? "gating",
  };
}

/**
 * Project a predicate verdict. Boolean in, `0|1` out against a threshold of
 * `1`, so a predicate reads on the dashboard exactly like every other scorer.
 * The evaluator's `reason` is the load-bearing diagnostic and survives as the
 * rationale.
 */
export function scoreResultFromPredicateResult(
  definition: ResolvedScoreDefinition,
  result: PredicateResult
): ScoreResult {
  return finalizeScoreResult(definition, {
    kind: "scored",
    value: result.passed ? 1 : 0,
    rationale: result.reason,
    ...(result.scope ? { scope: result.scope } : {}),
  });
}

/**
 * The definition for the `expectedToolCalls` matcher.
 *
 * `implementationHash` covers BOTH the expectations and the resolved matcher
 * policy: flipping `toolCallOrder` from `"ignore"` to `"strict"` changes the
 * verdict on an unchanged transcript, so it is an evaluation-config change.
 */
export function toolMatchScoreDefinition(options: {
  expectedToolCalls: EvalExpectedToolCall[];
  matchOptions: Required<Omit<EvalMatchOptions, "allowExtraToolCalls">>;
  role?: ScorerRole;
}): ScoreDefinition {
  return {
    scorerId: TOOL_MATCH_SCORER_ID,
    idSource: "explicit",
    scorerVersion: TOOL_MATCH_VERSION,
    implementationHash: canonicalDigest({
      expectedToolCalls: options.expectedToolCalls.map((call) => ({
        toolName: call.toolName,
        arguments: call.arguments ?? {},
      })),
      matchOptions: options.matchOptions,
    }),
    label: "expected tool calls",
    deterministic: true,
    passThreshold: 1,
    role: options.role ?? "gating",
  };
}

function describeToolMatch(match: EvalToolCallMatchResult): string {
  if (match.passed) {
    return "every expected tool call was observed";
  }
  const parts: string[] = [];
  if (match.missing.length > 0) {
    parts.push(
      `missing ${match.missing.map((call) => call.toolName).join(", ")}`
    );
  }
  if (match.argumentMismatches.length > 0) {
    parts.push(
      `argument mismatch on ${match.argumentMismatches
        .map((mismatch) => mismatch.toolName)
        .join(", ")}`
    );
  }
  if (match.outOfOrder.length > 0) {
    parts.push(
      `out of order: ${match.outOfOrder.map((call) => call.toolName).join(", ")}`
    );
  }
  if (match.extra.length > 0) {
    parts.push(`extra ${match.extra.map((call) => call.toolName).join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : "tool-call expectations unmet";
}

/**
 * Project the tool-call matcher's verdict. The `extra[]` list is reported in
 * the rationale but does not by itself decide the outcome — that is the
 * matcher's `passed`, which already applies the `maxExtraToolCalls` policy.
 */
export function fromToolMatchResult(
  definition: ResolvedScoreDefinition,
  match: EvalToolCallMatchResult
): ScoreResult {
  return finalizeScoreResult(definition, {
    kind: "scored",
    value: match.passed ? 1 : 0,
    rationale: describeToolMatch(match),
  });
}

/**
 * The definition for the legacy `test()` boolean.
 *
 * `implementationHash` is a CONSTANT, and deliberately so: the test body is an
 * opaque closure with no serializable configuration. Hashing `String(fn)` was
 * considered and rejected — it varies with transpilation and minification, so
 * the same test would digest differently from a `tsx` run and a bundled run,
 * and every case would read as `configChanged` when nothing changed. The
 * consequence is stated rather than hidden: two different `test()` bodies
 * produce the same `implementationHash`, and changes to a test body do not
 * reach the evaluation config hash.
 */
export function legacyTestScoreDefinition(options?: {
  role?: ScorerRole;
}): ScoreDefinition {
  return {
    scorerId: LEGACY_TEST_SCORER_ID,
    idSource: "explicit",
    scorerVersion: LEGACY_TEST_VERSION,
    implementationHash: canonicalDigest({ kind: "legacy-test" }),
    label: "test()",
    deterministic: true,
    passThreshold: 1,
    role: options?.role ?? "gating",
  };
}

/** Project the legacy `test()` boolean into a score. */
export function fromLegacyTestOutcome(
  definition: ResolvedScoreDefinition,
  passed: boolean
): ScoreResult {
  return finalizeScoreResult(definition, {
    kind: "scored",
    value: passed ? 1 : 0,
    rationale: passed
      ? "test() returned true"
      : "test() returned false",
  });
}

/**
 * Project one hosted goalCompletion case row.
 *
 * The row's own `passed` is READ AND DISCARDED. The threshold on the definition
 * is authoritative (the hosted generator already works this way), so a judge
 * that reports `{score: 0.2, passed: true}` cannot smuggle a pass through — the
 * derived value is what lands.
 */
export function fromGoalCompletionCase(
  definition: ResolvedScoreDefinition,
  row: {
    caseKey?: string;
    score: number;
    passed?: boolean;
    reason?: string;
    rubricHits?: string[];
  }
): ScoreResult {
  return finalizeScoreResult(definition, {
    kind: "scored",
    value: row.score,
    ...(row.reason ? { rationale: row.reason } : {}),
    ...(row.rubricHits && row.rubricHits.length > 0
      ? { evidence: row.rubricHits }
      : {}),
  });
}

/**
 * Project one graded rubric criterion. A criterion is boolean, so it maps the
 * same way a predicate does: `0|1` against a threshold of `1`, carrying the
 * evaluator's sentence and any per-turn scope.
 */
export function fromCriterionResult(
  definition: ResolvedScoreDefinition,
  row: {
    criterionId: string;
    passed: boolean;
    reason?: string;
    scope?: PredicateResult["scope"];
  }
): ScoreResult {
  return finalizeScoreResult(definition, {
    kind: "scored",
    value: row.passed ? 1 : 0,
    ...(row.reason ? { rationale: row.reason } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
  });
}
