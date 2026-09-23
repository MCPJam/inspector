/**
 * The score-contract definitions a HOSTED iteration grades against.
 *
 * Pure: builders only, no I/O and no evaluation. Every definition goes through
 * the SDK's `resolveScoreDefinition` / `definitionHash` / `evaluationConfigHash`
 * — nothing here hashes by hand, because two producers of the same digest is
 * exactly how a `definitionHash` stops meaning anything.
 *
 * Five scorers, and the roles are the load-bearing part:
 *
 *   | scorerId                   | deterministic | role         | threshold  |
 *   |----------------------------|---------------|--------------|------------|
 *   | `predicate:<criterionId>`  | true          | check policy | 1          |
 *   | `toolCalls:match`          | true          | gating       | 1          |
 *   | `toolCalls:arguments`      | true          | gating       | 1          |
 *   | `judge:goalCompletion`     | false         | from the run | resolved   |
 *   | `judge:rubricChecks:<key>` | false         | advisory     | per answer |
 *
 * The two `toolCalls:*` scorers are the tool-call matcher's verdict split at
 * the chain's stages: `match` is WHICH tools were called (Selection),
 * `arguments` is HOW the expected ones were called (Tool call). Both gate, and
 * together they pass exactly when the matcher did, so a gate on the pair means
 * what a gate on the old single row meant.
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
import {
  checkRole,
  stripCheckPolicy,
  type Predicate,
  type PredicateScope,
} from "@mcpjam/sdk/predicates";

/**
 * Scorer identity lives in `shared/` so the client can mint the same ids it
 * has to join against. Re-exported here because this module is where every
 * server caller already looks for them.
 */
import {
  hostedCriterionId,
  hostedRubricCheckScorerId,
  HOSTED_JUDGE_SCORER_ID,
  HOSTED_TOOL_ARGUMENTS_SCORER_ID,
  HOSTED_TOOL_MATCH_SCORER_ID,
} from "@/shared/hosted-criterion-id";

export {
  hostedCriterionId,
  hostedPredicateScorerId,
  hostedRubricCheckScorerId,
  HOSTED_RUBRIC_CHECKS_SCORER_PREFIX,
  HOSTED_TOOL_ARGUMENTS_SCORER_ID,
  HOSTED_TOOL_MATCH_SCORER_ID,
  HOSTED_JUDGE_SCORER_ID,
} from "@/shared/hosted-criterion-id";
import { authoredRequiredRole } from "@mcpjam/sdk/contract";
import { isRequiredRole } from "@mcpjam/sdk/predicates";

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
 *
 * BUMPED to "3" when the arguments moved out into `toolCalls:arguments`. The
 * row now passes on SELECTION alone — per turn, no missing call and extras
 * within `maxExtraToolCalls` (order folds in through both) — so a v3 row and a
 * v2 row can disagree on the same transcript, and the version says so. That
 * also moves `evaluationConfigHash`: a run graded before the split cannot be
 * gated against one graded after it, by design, until it is re-baselined.
 */
export const HOSTED_TOOL_MATCH_EVALUATOR_VERSION = "3";
/** Version of the hosted tool-call arguments projection. */
export const HOSTED_TOOL_ARGUMENTS_EVALUATOR_VERSION = "1";
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

/** `predicate:<criterionId>` — deterministic; role from the check policy. */
export function hostedPredicateScoreDefinition(args: {
  predicate: Predicate;
  scope?: PredicateScope;
}): ScoreDefinition {
  const criterionId = hostedCriterionId(args.predicate, args.scope);
  const criterion = stripCheckPolicy(args.predicate);
  return {
    scorerId: `predicate:${criterionId}`,
    idSource: "platform",
    scorerVersion: HOSTED_PREDICATE_EVALUATOR_VERSION,
    implementationHash: canonicalDigest({
      evaluatorVersion: HOSTED_PREDICATE_EVALUATOR_VERSION,
      criterion,
      ...(args.scope ? { scope: args.scope } : {}),
    }),
    label: args.predicate.type,
    deterministic: true,
    passThreshold: 1,
    role: checkRole(args.predicate),
    ...(args.scope ? { scope: args.scope } : {}),
  };
}

/**
 * `toolCalls:match` — deterministic, gating, threshold 1. Selection only: the
 * arguments are `toolCalls:arguments`.
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
    role: authoredRequiredRole(),
  };
}

/**
 * `toolCalls:arguments` — deterministic, gating, threshold 1.
 *
 * Declared only when the case expects tool calls and compares their arguments
 * (`argumentMatching !== "ignore"`): an ignored comparison has no verdict to
 * report, and a gating row that could only ever pass would be a vacuous gate.
 *
 * The hash covers the full RESOLVED match options, not just
 * `argumentMatching`: which actual call an expected one is compared against is
 * decided by the pairing, and `toolCallOrder` decides the pairing.
 */
export function hostedToolArgumentsScoreDefinition(args: {
  matchOptions?: Record<string, unknown>;
}): ScoreDefinition {
  return {
    scorerId: HOSTED_TOOL_ARGUMENTS_SCORER_ID,
    idSource: "platform",
    scorerVersion: HOSTED_TOOL_ARGUMENTS_EVALUATOR_VERSION,
    implementationHash: canonicalDigest({
      evaluatorVersion: HOSTED_TOOL_ARGUMENTS_EVALUATOR_VERSION,
      matchOptions: args.matchOptions ?? {},
    }),
    label: "expected tool call arguments",
    deterministic: true,
    passThreshold: 1,
    role: authoredRequiredRole(),
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
   * the verdict the backend stamped. Absent, or anything the build does not
   * recognise, is advisory — the default has to fail closed, because a role
   * this build cannot read must never be read as licence to fail a run.
   *
   * BOTH spellings of the required role are recognised. The backend stamped
   * `"gating"` before the rename and stamps `"required"` after it, and this
   * field is read off historical evidence, so "recognised" has to mean both
   * forever — a comparator that took only one would un-gate every judge on one
   * side of that line, silently.
   */
  role?: ScorerRole;
}): ScoreDefinition {
  const role: ScorerRole = isRequiredRole(args.role)
    ? authoredRequiredRole()
    : "advisory";
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

/** Version of the hosted rubric-check projection (NOT the question template). */
export const HOSTED_RUBRIC_CHECKS_PROJECTION_VERSION = "1";

/**
 * The model every rubric-check DEFINITION names. The row names the rail that
 * actually answered (Jev, or the fallback model when Jev could not be
 * reached), outside `definitionHash`, so a fallback on one trial never forks a
 * criterion's identity across the run.
 */
export const HOSTED_RUBRIC_CHECKS_MODEL = "typesafe-ai/jev";

/** One asked rubric-check question, as the backend's verdict describes it. */
export type HostedRubricCheckDefinitionInput = {
  /** `c:<criterionId>` for a suite criterion, `q:<questionId>` if authored. */
  key: string;
  kind: "boolean" | "choice" | "score";
  label: string;
  /** Digest of the rendered question and its pass line, from the backend. */
  contentDigest: string;
  passThreshold: number;
  templateVersion?: number;
  templateHash?: string;
};

/**
 * `judge:rubricChecks:<key>` — non-deterministic and ALWAYS advisory.
 *
 * The hash covers the question's content digest (its wording, options, levels
 * and pass line), its kind and the question template. Rewording a criterion
 * therefore mints a new definition under the same scorer id: a different
 * question, honestly, and one a baseline comparison shows as removed and
 * added. The settings page says so where the wording is edited.
 */
export function hostedRubricCheckScoreDefinition(
  args: HostedRubricCheckDefinitionInput,
): ScoreDefinition {
  return {
    scorerId: hostedRubricCheckScorerId(args.key),
    idSource: "platform",
    scorerVersion: HOSTED_RUBRIC_CHECKS_PROJECTION_VERSION,
    implementationHash: canonicalDigest({
      kind: args.kind,
      contentDigest: args.contentDigest,
      templateVersion: args.templateVersion ?? null,
      templateHash: args.templateHash ?? null,
    }),
    label: `rubric check: ${args.label}`,
    deterministic: false,
    passThreshold: args.passThreshold,
    role: "advisory",
    model: HOSTED_RUBRIC_CHECKS_MODEL,
  };
}

/**
 * Emitted only when the agent-activity guard fired, so a normal run's
 * `evaluationConfigHash` stays unchanged.
 */
export const HOSTED_AGENT_ACTIVITY_SCORER_ID = "platform:agentActivity";

export const HOSTED_AGENT_ACTIVITY_VERSION = "1";

export function hostedAgentActivityScoreDefinition(): ScoreDefinition {
  return {
    scorerId: HOSTED_AGENT_ACTIVITY_SCORER_ID,
    idSource: "platform",
    scorerVersion: HOSTED_AGENT_ACTIVITY_VERSION,
    implementationHash: canonicalDigest({
      evaluatorVersion: HOSTED_AGENT_ACTIVITY_VERSION,
    }),
    label: "agent activity",
    deterministic: true,
    passThreshold: 1,
    // Gating, so the row lands in `unresolvedScorerIds` ("not measured")
    // rather than as a failed criterion.
    role: "gating",
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
  /**
   * Present when the case authored tool-call expectations AND compares their
   * arguments. See `hostedToolArgumentsScoreDefinition`.
   */
  toolArguments?: {
    matchOptions?: Record<string, unknown>;
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
  /** A boolean, not the assessment, so the detail never affects the scorer's hash. */
  agentActivityFired?: boolean;
  /** One per question the rubric-check pass asked (second pass only). */
  rubricChecks?: ReadonlyArray<HostedRubricCheckDefinitionInput>;
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
  if (inputs.toolArguments) {
    definitions.push(hostedToolArgumentsScoreDefinition(inputs.toolArguments));
  }
  if (inputs.judge) {
    definitions.push(hostedJudgeScoreDefinition(inputs.judge));
  }
  if (inputs.agentActivityFired) {
    definitions.push(hostedAgentActivityScoreDefinition());
  }
  for (const question of inputs.rubricChecks ?? []) {
    definitions.push(hostedRubricCheckScoreDefinition(question));
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
