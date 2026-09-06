/**
 * The versioned evaluation contract — data shapes only.
 *
 * This module is browser-safe and intentionally has no node-only deps so it
 * can be imported into client bundles via `@mcpjam/sdk/contract` (same
 * convention as `../matchers.ts`).
 *
 * Every eval surface — code-first SDK runs, hosted runs, PR checks, schedules
 * — reports verdicts in ONE shape: a {@link ScoreResult} per scorer, joined to
 * its {@link ResolvedScoreDefinition} through the {@link EvaluationConfigSnapshot}
 * that shipped with the run. Predicates, tool-call matching, the legacy `test()`
 * boolean and LLM judges are all projected into that one shape rather than each
 * carrying its own result type.
 *
 * Three identities are kept deliberately separate and must never be conflated:
 *
 *   - `scenarioKey`          — stable case identity (today's caseKey).
 *   - `scenarioContentHash`  — prompt / expectation content.
 *   - `evaluationConfigHash` — scorers, thresholds, judge models and prompts.
 *
 * Changing scorer configuration must NOT fork case identity: the backend hashes
 * `{caseTitle,isNegativeTest,steps,advancedConfig}` into the caseKey, so scorer
 * definitions ride in `metadata.evaluationConfig` — never in `advancedConfig`.
 */

import type { PredicateScope } from "../predicates/types.js";

/**
 * Whether a scorer produced a number, blew up, was expected to run and didn't,
 * or simply does not apply.
 *
 *   - `"scored"`         — a value in [0,1] was produced. The only status that
 *     carries a verdict.
 *   - `"error"`          — the scorer threw, timed out, or returned something
 *     malformed. NEVER a low score: a crashed judge that reported `0` would be
 *     indistinguishable from a judge that ran and disagreed.
 *   - `"skipped"`        — expected work that did not happen (the iteration
 *     errored before scoring, a required input was missing). For a gating
 *     scorer this fails closed by default: an unscored gate is not a passed
 *     gate.
 *   - `"not_applicable"` — the scorer does not apply to this iteration at all
 *     (e.g. tool matching on a case that configured no expectations). NEVER
 *     gates, and is excluded from every aggregation denominator — which is
 *     exactly what distinguishes it from `"skipped"`.
 */
export type ScoreStatus = "scored" | "error" | "skipped" | "not_applicable";

/**
 * Whether a scorer's verdict decides the iteration.
 *
 *   - `"gating"`   — a failing (or, per policy, an errored/skipped) score fails
 *     the iteration.
 *   - `"advisory"` — reported and rendered, never consulted for `passed`. The
 *     hosted stance for judges ("Never mutates the run's `passed`") is the
 *     default here too.
 */
export type ScorerRole = "gating" | "advisory";

/**
 * What a gating scorer's non-verdict status does to the iteration.
 * `"fail"` is the fail-closed default for gating scorers; `"ignore"` is the
 * default for advisory ones, whose statuses never gate anyway.
 */
export type ScorerErrorPolicy = "fail" | "ignore";

/**
 * Where an explicit `scorerId` came from.
 *
 *   - `"explicit"`  — the author named it. Stable across config edits, so it is
 *     the only kind a CI gate or a cross-run diff may reference.
 *   - `"generated"` — the runtime minted it positionally (e.g.
 *     `predicate:responseContains#2`). **Positional and UNSTABLE**: inserting a
 *     predicate above it renumbers it, so diffing and aggregation must not
 *     track a generated id across config edits, and {@link GatePolicy}-style
 *     selection by id must reject one.
 *   - `"platform"`  — the hosted platform minted it from a stable, non-positional
 *     key (`predicate:<criterionId>`, `toolCalls:match`, `judge:goalCompletion`).
 *     Stable across config edits like `"explicit"`, but nobody authored it, so a
 *     report can still say where the id came from.
 */
export type ScorerIdSource = "explicit" | "generated" | "platform";

/**
 * What a scorer is and how its verdict is treated — the authored half of the
 * contract.
 *
 * `implementationHash` is REQUIRED, and it is the field that makes this shape
 * honest. `scorerVersion` is author-maintained and therefore forgettable: two
 * judges whose prompts differ would hash identically unless someone remembered
 * to bump it. `implementationHash` is derived from what the scorer actually
 * does — the canonicalized predicate, the canonicalized prompt/rubric plus
 * template version, or an author-supplied config hash for a custom scorer — so
 * a changed prompt always changes the evaluation config hash.
 */
export type ScoreDefinition = {
  /** Stable, author-facing identifier. Max 128 chars. */
  scorerId: string;
  /** Whether {@link scorerId} is author-chosen or positionally generated. */
  idSource: ScorerIdSource;
  /** Author-maintained version of the scorer's semantics. */
  scorerVersion: string;
  /**
   * Digest of what the scorer actually does. See the type docs — this is not
   * optional and not a convenience.
   */
  implementationHash: string;
  /** Human label for dashboards. Never load-bearing. */
  label?: string;
  /**
   * True when the same transcript always yields the same value. Judges are
   * `false`; predicates, tool matching and the legacy boolean are `true`.
   * Read by the retry-exhausted path: deterministic scorers can still score a
   * partial transcript, non-deterministic ones are skipped.
   */
  deterministic: boolean;
  /**
   * The bar a value must reach. Predicates / tool-match / legacy boolean use
   * `1`; judges default to `0.7` (the hosted `judgeConfig` default).
   */
  passThreshold: number;
  role: ScorerRole;
  /** Defaults to `"fail"` when gating, `"ignore"` when advisory. */
  onError?: ScorerErrorPolicy;
  /**
   * Defaults to `"fail"` when gating, `"ignore"` when advisory. Deliberately
   * separate from {@link onError}: "the judge crashed" and "the judge never
   * ran" are different failures and a team may reasonably tolerate one and not
   * the other.
   */
  onSkipped?: ScorerErrorPolicy;
  /** Model string for non-deterministic scorers, e.g. `"anthropic/claude-sonnet-4-6"`. */
  model?: string;
  /** Absent ⇒ case-level; `{ kind: "turn", promptIndex }` ⇒ per-turn. */
  scope?: PredicateScope;
};

/**
 * A {@link ScoreDefinition} with every semantic default filled in.
 *
 * This is the hashing form AND the wire form. Resolving before hashing is what
 * makes an omitted `onError` and an explicitly-configured `"fail"` hash
 * identically — without it, a no-op edit that spells out a default would read
 * as an evaluation-config change and flag every case as `configChanged`.
 */
export type ResolvedScoreDefinition = Omit<
  ScoreDefinition,
  "onError" | "onSkipped"
> & {
  onError: ScorerErrorPolicy;
  onSkipped: ScorerErrorPolicy;
};

/**
 * The join table gates and renderers read.
 *
 * Results carry only a `definitionHash`; role and error policies live here. A
 * consumer holding results alone cannot tell a gating failure from an advisory
 * one, which is why the public projection must expose BOTH.
 */
export type EvaluationConfigSnapshot = {
  /**
   * `evaluationConfigHash` over the resolved definitions. Order-independent —
   * the hash sorts internally — so `definitions` may stay in authored order.
   */
  hash: string;
  definitions: ResolvedScoreDefinition[];
};

/**
 * One scorer's verdict for one iteration.
 *
 * Deliberately does NOT repeat `role`, `onError` or `onSkipped`: duplicating
 * policy onto every row invites the two copies to disagree, and a disagreement
 * about whether something gates is precisely the disagreement you cannot
 * afford. Consumers join to the snapshot on {@link definitionHash}.
 */
export type ScoreResult = {
  scorerId: string;
  scorerVersion: string;
  /** Joins this result to its definition in the run's snapshot. */
  definitionHash: string;
  status: ScoreStatus;
  /** Present iff `status === "scored"`. Always within [0,1]. */
  value?: number;
  /** Echoed from the definition so a row renders without the join. */
  passThreshold: number;
  /**
   * DERIVED as `value >= passThreshold`, present iff `status === "scored"`.
   * Never model-asserted and never scorer-asserted — a judge that returns
   * `{score: 0.2, passed: true}` does not get to overrule the threshold.
   */
  passed?: boolean;
  /** Free-text explanation. Truncated to 2000 chars by the producer. */
  rationale?: string;
  /** Supporting snippets. At most 20 entries, each truncated to 300 chars. */
  evidence?: string[];
  deterministic: boolean;
  model?: string;
  /**
   * Digest of the judge request as SENT — every channel of it, not just the
   * user turn — for reproducibility triage.
   */
  promptHash?: string;
  /** Present iff `status === "error"`. Truncated to 500 chars. */
  error?: string;
  scope?: PredicateScope;
};

/**
 * What a {@link Scorer} returns: an observation, never a finished verdict.
 *
 * Scorers cannot mint a {@link ScoreResult} directly — `passed` is derived and
 * bounds are enforced in exactly one place (`finalizeScoreResult`), so there is
 * no code path where a scorer asserts its own verdict.
 */
export type ScoreRawOutcome =
  | {
      kind: "scored";
      /** Must be a finite number in [0,1]; anything else finalizes to `error`. */
      value: number;
      rationale?: string;
      evidence?: string[];
      model?: string;
      promptHash?: string;
      scope?: PredicateScope;
    }
  | { kind: "skipped"; rationale?: string; scope?: PredicateScope }
  | { kind: "not_applicable"; rationale?: string; scope?: PredicateScope };

/**
 * The versioned input a scorer grades against.
 *
 * Richer than {@link IterationTranscript}, which stays predicate-minimal by
 * design: predicates consume `context.transcript` and nothing else, while a
 * judge needs the message trace, the expectations and the usage totals.
 *
 * `version: 1` is a literal so a future `ScorerContextV2` can be discriminated
 * rather than sniffed.
 *
 * An `AbortSignal` is deliberately NOT a field here: signals are not data, they
 * do not serialize, and a context that cannot be written to a fixture is a
 * context nobody can test against. It is passed as a separate argument to
 * `score(context, signal)`.
 */
export type ScorerContextV1 = {
  version: 1;
  scenario: {
    title: string;
    isNegativeTest?: boolean;
    /** Stable case identity when the caller knows it. */
    scenarioKey?: string;
  };
  /** Exactly what the deterministic predicates evaluate against. */
  transcript: import("../predicates/types.js").IterationTranscript;
  trace: {
    messages: Array<{ role: string; content: unknown }>;
    spans?: import("../eval-reporting-types.js").EvalTraceSpanInput[];
  };
  expectedOutput?: string;
  expectedToolCalls?: import("../eval-reporting-types.js").EvalExpectedToolCall[];
  usage?: import("../predicates/types.js").TranscriptUsage;
};

/** Max length of a `scorerId`. */
export const MAX_SCORER_ID_LENGTH = 128;
/** `rationale` is truncated to this many characters by the producer. */
export const MAX_RATIONALE_LENGTH = 2000;
/** `error` is truncated to this many characters by the producer. */
export const MAX_ERROR_LENGTH = 500;
/** At most this many `evidence` entries survive. */
export const MAX_EVIDENCE_ENTRIES = 20;
/** Each `evidence` entry is truncated to this many characters. */
export const MAX_EVIDENCE_ENTRY_LENGTH = 300;

/**
 * Version of the deterministic predicate evaluator, stamped as `scorerVersion`
 * on every predicate-derived definition. Bumping it is how a change in
 * predicate *evaluation semantics* (as opposed to a change in an individual
 * authored predicate, which `implementationHash` covers) reaches the
 * evaluation config hash.
 */
export const PREDICATES_VERSION = "1";
