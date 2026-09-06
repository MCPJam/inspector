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
 *   | scorerId                  | deterministic | role         | threshold |
 *   |---------------------------|---------------|--------------|-----------|
 *   | `predicate:<criterionId>` | true          | gating       | 1         |
 *   | `toolCalls:match`         | true          | gating       | 1         |
 *   | `judge:goalCompletion`    | false         | from the run | resolved  |
 *
 * THE JUDGE'S ROLE COMES FROM THE RUN, NOT FROM THIS FILE. It used to be
 * hard-coded advisory, which made a gating judge structurally powerless: a
 * suite could earn the gate, the backend could hold the run for it, and the
 * projection would still emit a row `sdk/src/gates.ts` never considers.
 *
 * It is read off `metadata.judgeVerdict.role`, which the backend stamps from
 * the run's FROZEN config — so a run that started advisory cannot be
 * retroactively gated by a later suite edit, and a run override that lowered
 * the judge is honoured here exactly as it was at grading time. The decision is
 * a closed one: the literal `"gating"` gates; absent, `"advisory"`, and
 * anything else are advisory, because a role this build does not recognise must
 * never be read as licence to fail a run.
 *
 * A gating judge's row then enters `allGatingScorersPassed` and
 * `noGatingScoreErrors` exactly like a predicate's. Two invariants still hold
 * STRUCTURALLY rather than by this file's choice: a judge row never carries
 * `passed` unless it actually scored, so an errored judge cannot fail a trial
 * on its own (the backend quarantines it instead); and the backend's finalizer
 * applies a gating judge STRICTER-ONLY, so it can take a green away and never
 * hand one out.
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
/**
 * Version of the hosted tool-match projection.
 *
 * BUMPED to "2" in B3b. The runner now threads the RESOLVED match options and
 * the case polarity into this definition — before, both were simply absent from
 * every hosted iteration, so `implementationHash` was computed over `{}` for a
 * scorer that was in fact grading order-agnostic with partial argument
 * matching. Fixing that changes the digest of every hosted `toolCalls:match`
 * definition.
 *
 * The bump is what makes that change VERSIONED rather than silent: without it,
 * two runs graded identically would carry different `implementationHash`es for
 * the same `scorerVersion`, and a reader comparing them would have no way to
 * tell a fixed projection from a changed scorer. With it, the digest moves
 * because the version moved, which is exactly what a version is for.
 */
export const HOSTED_TOOL_MATCH_EVALUATOR_VERSION = "2";
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
  /**
   * What the RUN's frozen config said this judge was allowed to do, read off
   * the verdict the backend stamped. Absent, or anything but the literal
   * `"gating"`, is advisory — the default has to fail closed, because a role
   * this build does not recognise must never be read as licence to fail a run.
   */
  role?: "advisory" | "gating";
}): ScoreDefinition {
  const role = args.role ?? "advisory";
  return {
    scorerId: HOSTED_JUDGE_SCORER_ID,
    idSource: "platform",
    scorerVersion: HOSTED_JUDGE_PROJECTION_VERSION,
    // `role` is DELIBERATELY not an input here. It is already an input to
    // `definitionHash` in the contract, so a gating judge gets a distinct
    // digest without re-fingerprinting the implementation — and an advisory
    // judge's implementation hash stays byte-identical to every hosted run
    // that has ever been recorded.
    implementationHash: canonicalDigest({
      judgeTemplateVersion: args.judgeTemplateVersion ?? null,
      judgeTemplateHash: args.judgeTemplateHash ?? null,
      partialFloor: args.partialFloor ?? null,
      objectiveScoreCap:
        args.objectiveScoreCap ?? HOSTED_JUDGE_OBJECTIVE_SCORE_CAP,
    }),
    label: `goal completion (${role})`,
    deterministic: false,
    passThreshold: args.threshold,
    role,
    // `onError` / `onSkipped` are deliberately NOT set. `resolveScoreDefinition`
    // defaults them to `ignore` for an advisory definition and `fail` for a
    // gating one, which is exactly what the backend finalizer reads — stating
    // them here would be a second copy of that rule, free to drift from it.
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
    /** From the run's frozen config, via the stamped verdict. Fails closed. */
    role?: "advisory" | "gating";
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
