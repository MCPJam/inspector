/**
 * The score-contract definitions a HOSTED iteration grades against.
 *
 * Pure: builders only, no I/O and no evaluation. Every definition goes through
 * the SDK's `resolveScoreDefinition` / `definitionHash` / `evaluationConfigHash`
 * — nothing here hashes by hand, because two producers of the same digest is
 * exactly how a `definitionHash` stops meaning anything.
 *
 * Three scorers, and the roles are the load-bearing part:
 *
 *   | scorerId                  | deterministic | role     | threshold |
 *   |---------------------------|---------------|----------|-----------|
 *   | `predicate:<criterionId>` | true          | gating   | 1         |
 *   | `toolCalls:match`         | true          | gating   | 1         |
 *   | `judge:goalCompletion`    | false         | ADVISORY | resolved  |
 *
 * `role: "advisory"` on the judge is what makes it structurally incapable of
 * gating: `sdk/src/gates.ts` only ever considers gating scorers, so an advisory
 * row cannot decide a customer's CI no matter what it scores.
 */

import {
  buildEvaluationConfigSnapshot,
  canonicalDigest,
  resolveScoreDefinition,
  type EvaluationConfigSnapshot,
  type ResolvedScoreDefinition,
  type ScoreDefinition,
} from "@mcpjam/sdk/contract";
import type { Predicate, PredicateScope } from "@mcpjam/sdk/predicates";

/** Stable id of the hosted tool-call matcher projection. */
export const HOSTED_TOOL_MATCH_SCORER_ID = "toolCalls:match";
/** Stable id of the hosted advisory judge projection. */
export const HOSTED_JUDGE_SCORER_ID = "judge:goalCompletion";

/**
 * Version of the hosted predicate projection — the "predicate evaluator
 * version" half of the predicate `implementationHash` inputs.
 */
export const HOSTED_PREDICATE_EVALUATOR_VERSION = "1";
/** Version of the hosted tool-match projection. */
export const HOSTED_TOOL_MATCH_EVALUATOR_VERSION = "1";
/** Version of the hosted judge projection (NOT the judge template version). */
export const HOSTED_JUDGE_PROJECTION_VERSION = "1";

/**
 * Score ceiling the backend applies to objective-mode judging (no rubric).
 * Mirrors `OBJECTIVE_MODE_SCORE_CAP` in the backend judge template and is a
 * HASH INPUT: moving the cap changes what a judge score means, so it must move
 * the judge definition's digest even when the template text is untouched.
 * Callers may override it with the value a historical row was graded under.
 */
export const HOSTED_JUDGE_OBJECTIVE_SCORE_CAP = 0.85;

/**
 * The criterion identity of one hosted predicate.
 *
 * Hosted cases author predicates, not named criteria, so the id is derived
 * from the predicate's CONTENT (plus its turn scope, which is part of what is
 * being asserted) rather than from its position. Content-derived means stable
 * across an edit elsewhere in the list — `idSource: "platform"` records that
 * the platform minted it, so a report never claims an author chose this name.
 */
export function hostedCriterionId(
  predicate: Predicate,
  scope?: PredicateScope
): string {
  const digest = canonicalDigest(
    scope ? { predicate, scope } : { predicate }
  ).slice(0, 12);
  return `${predicate.type}-${digest}`;
}

/** `predicate:<criterionId>` — deterministic, gating, threshold 1. */
export function hostedPredicateScoreDefinition(args: {
  predicate: Predicate;
  scope?: PredicateScope;
}): ScoreDefinition {
  const criterionId = hostedCriterionId(args.predicate, args.scope);
  return {
    scorerId: `predicate:${criterionId}`,
    idSource: "platform",
    scorerVersion: HOSTED_PREDICATE_EVALUATOR_VERSION,
    implementationHash: canonicalDigest({
      evaluatorVersion: HOSTED_PREDICATE_EVALUATOR_VERSION,
      criterion: args.predicate,
      ...(args.scope ? { scope: args.scope } : {}),
    }),
    label: args.predicate.type,
    deterministic: true,
    passThreshold: 1,
    role: "gating",
    ...(args.scope ? { scope: args.scope } : {}),
  };
}

/**
 * `toolCalls:match` — deterministic, gating, threshold 1.
 *
 * The hash covers the RESOLVED match options and the case polarity, for the
 * same reason `toolMatchScoreDefinition` does: flipping `toolCallOrder` or
 * `isNegativeTest` changes the verdict on an unchanged transcript.
 */
export function hostedToolMatchScoreDefinition(args: {
  matchOptions?: Record<string, unknown>;
  isNegativeTest?: boolean;
}): ScoreDefinition {
  return {
    scorerId: HOSTED_TOOL_MATCH_SCORER_ID,
    idSource: "platform",
    scorerVersion: HOSTED_TOOL_MATCH_EVALUATOR_VERSION,
    implementationHash: canonicalDigest({
      evaluatorVersion: HOSTED_TOOL_MATCH_EVALUATOR_VERSION,
      matchOptions: args.matchOptions ?? {},
      ...(args.isNegativeTest ? { isNegativeTest: true } : {}),
    }),
    label: "expected tool calls",
    deterministic: true,
    passThreshold: 1,
    role: "gating",
  };
}

/**
 * `judge:goalCompletion` — non-deterministic, ADVISORY, resolved threshold.
 *
 * The hash covers the judge template version, the template hash, the partial
 * floor and the objective-mode cap: all four change what a score MEANS without
 * necessarily changing the number, so all four must move the digest.
 */
export function hostedJudgeScoreDefinition(args: {
  /** The threshold the verdict was actually graded against. */
  threshold: number;
  partialFloor?: number;
  judgeTemplateVersion?: number;
  judgeTemplateHash?: string;
  objectiveScoreCap?: number;
  model?: string;
}): ScoreDefinition {
  return {
    scorerId: HOSTED_JUDGE_SCORER_ID,
    idSource: "platform",
    scorerVersion: HOSTED_JUDGE_PROJECTION_VERSION,
    implementationHash: canonicalDigest({
      judgeTemplateVersion: args.judgeTemplateVersion ?? null,
      judgeTemplateHash: args.judgeTemplateHash ?? null,
      partialFloor: args.partialFloor ?? null,
      objectiveScoreCap:
        args.objectiveScoreCap ?? HOSTED_JUDGE_OBJECTIVE_SCORE_CAP,
    }),
    label: "goal completion (advisory)",
    deterministic: false,
    passThreshold: args.threshold,
    // ADVISORY, always. See the module docblock.
    role: "advisory",
    ...(args.model ? { model: args.model } : {}),
  };
}

export type HostedScoreDefinitionInputs = {
  /** One entry per graded predicate, in the order the runner evaluated them. */
  predicates?: ReadonlyArray<{ predicate: Predicate; scope?: PredicateScope }>;
  /** Present when the case authored tool-call expectations. */
  toolMatch?: {
    matchOptions?: Record<string, unknown>;
    isNegativeTest?: boolean;
  };
  /** Present only once a judge verdict exists (i.e. on the second pass). */
  judge?: {
    threshold: number;
    partialFloor?: number;
    judgeTemplateVersion?: number;
    judgeTemplateHash?: string;
    objectiveScoreCap?: number;
    model?: string;
  };
};

/**
 * Every definition for one hosted iteration, resolved and de-duplicated by id.
 *
 * Two identical predicates in the same scope are ONE criterion: their ids are
 * content-derived, so keeping both would make the results→definitions join
 * ambiguous (and `buildEvaluationConfigSnapshot` would rightly throw).
 */
export function buildHostedScoreDefinitions(
  inputs: HostedScoreDefinitionInputs
): ResolvedScoreDefinition[] {
  const definitions: ScoreDefinition[] = [];
  for (const entry of inputs.predicates ?? []) {
    definitions.push(
      hostedPredicateScoreDefinition({
        predicate: entry.predicate,
        ...(entry.scope ? { scope: entry.scope } : {}),
      })
    );
  }
  if (inputs.toolMatch) {
    definitions.push(hostedToolMatchScoreDefinition(inputs.toolMatch));
  }
  if (inputs.judge) {
    definitions.push(hostedJudgeScoreDefinition(inputs.judge));
  }
  const byId = new Map<string, ResolvedScoreDefinition>();
  for (const definition of definitions) {
    const resolved = resolveScoreDefinition(definition);
    if (!byId.has(resolved.scorerId)) {
      byId.set(resolved.scorerId, resolved);
    }
  }
  return [...byId.values()];
}

/**
 * The `evaluationConfig` snapshot shipped with a hosted iteration — the join
 * table its score rows resolve their definitions through.
 */
export function buildHostedEvaluationConfig(
  inputs: HostedScoreDefinitionInputs
): EvaluationConfigSnapshot {
  return buildEvaluationConfigSnapshot(buildHostedScoreDefinitions(inputs));
}
