/**
 * The canonical evaluator vocabulary, as types.
 *
 * One word per concept, defined once: an **evaluator** is an assertion or a
 * judge, an **iteration** is one execution of a case, an **evaluator result**
 * is what one evaluator observed, and a **verdict** is the policy-derived
 * decision. See `docs/evals-vocabulary-consolidation.md`.
 *
 * ── Why most of this file is aliases ─────────────────────────────────────────
 *
 * `EvaluatorDefinition` and friends are type aliases of the existing score
 * types, keeping their runtime keys (`scorerId`, `scorerVersion`) untouched.
 * That is not laziness about the rename: those eleven keys ARE the
 * `definitionHash` payload (`derive.ts`), so renaming one would rotate every
 * evaluator identity in every stored run, reset baseline comparability for
 * every suite, and do it silently — a changed hash reads exactly like a changed
 * configuration.
 *
 * `EvaluatorResult` is the one shape that genuinely renames fields, and it does
 * so as a VERSIONED PROJECTION rather than an alias: `value` becomes `score`,
 * so a type alias would have produced an `EvaluatorResult` with no `score` on
 * it and a `score` field nobody could find. Projections are explicit and
 * reversible; aliases over a differently-shaped runtime object are a lie the
 * compiler agrees with.
 */

import type {
  EvaluationConfigSnapshot,
  ResolvedScoreDefinition,
  ScoreDefinition,
  ScoreRawOutcome,
  ScoreResult,
  ScoreStatus,
  ScorerContextV1,
  ScorerErrorPolicy,
  ScorerIdSource,
  ScorerRole,
} from "./types.js";
import type { PredicateScope } from "../predicates/types.js";

/**
 * What an evaluator is, and there are exactly two kinds.
 *
 * Tool/trajectory matching is an assertion IMPLEMENTATION, not a third kind: it
 * is a deterministic authored rule, which is what the word means. A rendering
 * surface may keep a matcher-specific presentation variant without adding a
 * member here — presentation and domain are different questions, and conflating
 * them is how an enum acquires a member that means "looks different".
 */
export const EVALUATOR_KINDS = ["assertion", "judge"] as const;
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];

/** An assertion is a deterministic authored rule. */
export type Assertion = import("../predicates/types.js").Predicate;
/** What one assertion observed, before it is finalized into a result. */
export type AssertionResult = import("../predicates/types.js").PredicateResult;
/** Absent ⇒ whole iteration; `{ kind: "turn", promptIndex }` ⇒ one turn. */
export type AssertionScope = PredicateScope;

/** What an evaluator is and how its verdict is treated — the authored half. */
export type EvaluatorDefinition = ScoreDefinition;
/** An {@link EvaluatorDefinition} with every semantic default filled in. */
export type ResolvedEvaluatorDefinition = ResolvedScoreDefinition;
/** The versioned input an evaluator grades against. */
export type EvaluatorContextV1 = ScorerContextV1;
/** The join table gates and renderers read. */
export type EvaluatorConfigSnapshot = EvaluationConfigSnapshot;
export type EvaluatorStatus = ScoreStatus;
export type EvaluatorRole = ScorerRole;
export type EvaluatorErrorPolicy = ScorerErrorPolicy;
export type EvaluatorIdSource = ScorerIdSource;

/**
 * What an evaluator returns: an observation, never a finished verdict.
 *
 * `score` rather than `value`, matching the result it becomes. An evaluator
 * still cannot mint a result directly — bounds and `passed` are derived in one
 * place — so this is the whole of what an implementation gets to assert.
 */
export type EvaluatorRawOutcome =
  | {
      kind: "scored";
      /** Must be a finite number in [0,1]; anything else finalizes to `error`. */
      score: number;
      explanation?: string;
      evidence?: string[];
      model?: string;
      promptHash?: string;
      scope?: AssertionScope;
    }
  | { kind: "skipped"; explanation?: string; scope?: AssertionScope }
  | { kind: "not_applicable"; explanation?: string; scope?: AssertionScope };

/**
 * The version of {@link EvaluatorResult}'s shape.
 *
 * A literal so a future `2` can be DISCRIMINATED rather than sniffed from which
 * fields happen to be present. Field-presence sniffing is how a reader ends up
 * treating a genuinely new shape as a malformed old one.
 */
export const EVALUATOR_RESULT_SCHEMA_VERSION = 1 as const;

/**
 * One evaluator's observation for one iteration.
 *
 * Three rules survive the rename intact, and all three are the reason this is a
 * projection rather than a free-form object:
 *
 *   - `passed` is DERIVED as `score >= passThreshold`. A judge that returns
 *     `{score: 0.2, passed: true}` does not get to overrule its own threshold.
 *   - An `error`, `skipped` or `not_applicable` result carries NO `score`. A
 *     fabricated zero would put a defect on the dashboard that nobody observed,
 *     and a gating evaluator would fail the iteration on it.
 *   - Role and error policy are NOT repeated here. Consumers join to the config
 *     snapshot on `definitionHash`, because two copies of "does this gate" is
 *     precisely the disagreement you cannot afford.
 */
export type EvaluatorResult = {
  schemaVersion: typeof EVALUATOR_RESULT_SCHEMA_VERSION;
  /** Stable identity. The same opaque value the score contract has always used. */
  evaluatorId: string;
  evaluatorVersion: string;
  /** Joins this result to its definition in the run's snapshot. */
  definitionHash: string;
  /**
   * Derived, never stored on the definition — see {@link evaluatorKindOf}.
   * Dropped again on the way back, so the projection round-trips exactly.
   */
  kind: EvaluatorKind;
  status: EvaluatorStatus;
  /** Present iff `status === "scored"`. Always within [0,1]. */
  score?: number;
  passThreshold: number;
  /** Present iff `status === "scored"`. Derived, never asserted. */
  passed?: boolean;
  /** Free-text explanation. Truncated by the producer. */
  explanation?: string;
  evidence?: string[];
  deterministic: boolean;
  model?: string;
  promptHash?: string;
  /** Present iff `status === "error"`. */
  error?: string;
  scope?: AssertionScope;
};

/**
 * Which kind of evaluator produced a definition.
 *
 * DERIVED from `deterministic` rather than stored, because storing it would add
 * a twelfth field to the `definitionHash` payload and rotate every existing
 * evaluator identity — for a value that is already implied by one that is
 * there.
 *
 * The derivation is not a heuristic: `deterministic` means "the same transcript
 * always yields the same value", which is exactly what separates an authored
 * rule from a model's opinion. Tool matching and the legacy boolean come out as
 * assertions, which is the right answer for both.
 */
export function evaluatorKindOf(definition: {
  deterministic: boolean;
}): EvaluatorKind {
  return definition.deterministic ? "assertion" : "judge";
}

/** The legacy result shape this projects from. Re-exported for adapters. */
export type { ScoreResult, ScoreRawOutcome };
