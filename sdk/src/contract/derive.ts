/**
 * Derivation for the evaluation contract — resolution, hashing, and the ONLY
 * sanctioned producer of a {@link ScoreResult}.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * Every rule that could otherwise be re-implemented slightly differently by
 * each caller lives here exactly once:
 *
 *   - defaults resolution (`onError`/`onSkipped` from `role`),
 *   - what a definition hashes over,
 *   - `passed = value >= passThreshold`,
 *   - bounds/truncation on `rationale`, `evidence` and `error`,
 *   - what a scorer that returned garbage becomes (an `error`, never a score).
 *
 * A scorer returns a {@link ScoreRawOutcome}; only `finalizeScoreResult` turns
 * one into a verdict. That is the structural reason a scorer cannot assert its
 * own `passed`.
 */

import { canonicalJson, sha256Hex } from "./canonical.js";
import {
  MAX_ERROR_LENGTH,
  MAX_EVIDENCE_ENTRIES,
  MAX_EVIDENCE_ENTRY_LENGTH,
  MAX_RATIONALE_LENGTH,
  type EvaluationConfigSnapshot,
  type ResolvedScoreDefinition,
  type ScoreDefinition,
  type ScoreRawOutcome,
  type ScoreResult,
} from "./types.js";

/**
 * Fill every semantic default.
 *
 * The gating defaults are fail-closed on purpose: a gating scorer that errors,
 * or that was expected to run and didn't, fails the iteration unless the author
 * explicitly opts out. An advisory scorer's statuses never gate, so both
 * policies default to `"ignore"` there — which also keeps the resolved shape
 * total (no field is ever absent) without inventing a third "n/a" policy.
 */
export function resolveScoreDefinition(
  definition: ScoreDefinition
): ResolvedScoreDefinition {
  const fallback = definition.role === "gating" ? "fail" : "ignore";
  const { onError, onSkipped, ...rest } = definition;
  return {
    ...rest,
    onError: onError ?? fallback,
    onSkipped: onSkipped ?? fallback,
  };
}

/**
 * Exactly the fields a definition hashes over, projected explicitly.
 *
 * Two deliberate properties, both of which the Convex mirror must reproduce
 * field for field:
 *
 *   - **Projection, not spread.** An unknown extra key riding on a definition
 *     object must not silently change the digest.
 *   - **`label` is EXCLUDED.** It is presentation-only; hashing it would make
 *     fixing a typo in a dashboard label read as an evaluation-config change
 *     and flag every case in the next run as `configChanged`.
 */
function definitionHashPayload(
  definition: ResolvedScoreDefinition
): Record<string, unknown> {
  return {
    scorerId: definition.scorerId,
    idSource: definition.idSource,
    scorerVersion: definition.scorerVersion,
    implementationHash: definition.implementationHash,
    deterministic: definition.deterministic,
    passThreshold: definition.passThreshold,
    role: definition.role,
    onError: definition.onError,
    onSkipped: definition.onSkipped,
    model: definition.model,
    scope: definition.scope,
  };
}

/** Canonical-JSON + SHA-256 over one resolved definition. */
export function definitionHash(definition: ResolvedScoreDefinition): string {
  return sha256Hex(canonicalJson(definitionHashPayload(definition)));
}

/**
 * Canonical-JSON + SHA-256 over the whole resolved definition set.
 *
 * Definitions are sorted by their own canonical JSON before digesting, so the
 * hash is independent of authored order — a scorer moved up the list is not an
 * evaluation-config change. Stated precisely for the mirror: the digest is
 * SHA-256 of `"[" + sortedCanonicalPayloads.join(",") + "]"`, which is exactly
 * `canonicalDigest` of the sorted payload array.
 */
export function evaluationConfigHash(
  definitions: ResolvedScoreDefinition[]
): string {
  const canonical = definitions
    .map((definition) => canonicalJson(definitionHashPayload(definition)))
    .sort();
  return sha256Hex(`[${canonical.join(",")}]`);
}

/**
 * Roll several per-case evaluation-config hashes into ONE run-level hash.
 *
 * A suite grades each case with its own definition set, but a run has a single
 * fingerprint. Digesting the sorted list of per-case hashes gives an
 * order-independent value that changes when any case's scorers change, and
 * also when a case is added or removed.
 *
 * Duplicates are deliberately KEPT: two cases sharing an identical scorer set
 * is a different configuration from one case with that set, and collapsing them
 * would hide a deleted case from the fingerprint.
 */
export function aggregateEvaluationConfigHash(hashes: string[]): string {
  return sha256Hex(canonicalJson([...hashes].sort()));
}

/**
 * Build the join table shipped with a run. Accepts authored definitions and
 * resolves them, so callers cannot accidentally hash an unresolved shape.
 *
 * `definitions` stays in authored order — dashboards read it top to bottom —
 * which is safe precisely because {@link evaluationConfigHash} sorts.
 */
export function buildEvaluationConfigSnapshot(
  definitions: Array<ScoreDefinition | ResolvedScoreDefinition>
): EvaluationConfigSnapshot {
  const resolved = definitions.map((definition) =>
    resolveScoreDefinition(definition)
  );
  // Duplicate ids make the results→definitions join ambiguous, and an
  // ambiguous join is one where a gating policy can silently resolve to an
  // advisory twin. Caught here, at construction, rather than downstream where
  // the snapshot merely fails validation and the run loses its scores.
  const seen = new Set<string>();
  for (const definition of resolved) {
    if (seen.has(definition.scorerId)) {
      throw new Error(
        `Duplicate scorerId "${definition.scorerId}" in the evaluation config. ` +
          `Scorer ids must be unique within a run.`
      );
    }
    seen.add(definition.scorerId);
  }
  return { hash: evaluationConfigHash(resolved), definitions: resolved };
}

/**
 * The verdict rule, in one place: a score passes when it reaches its threshold.
 * Never model-asserted, never scorer-asserted.
 */
export function scorePassed(value: number, passThreshold: number): boolean {
  return value >= passThreshold;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function truncateEvidence(evidence: string[] | undefined): string[] | undefined {
  if (!evidence || evidence.length === 0) return undefined;
  return evidence
    .slice(0, MAX_EVIDENCE_ENTRIES)
    .map((entry) => truncate(String(entry), MAX_EVIDENCE_ENTRY_LENGTH));
}

function baseResult(
  definition: ResolvedScoreDefinition
): Pick<
  ScoreResult,
  | "scorerId"
  | "scorerVersion"
  | "definitionHash"
  | "passThreshold"
  | "deterministic"
> {
  return {
    scorerId: definition.scorerId,
    scorerVersion: definition.scorerVersion,
    definitionHash: definitionHash(definition),
    passThreshold: definition.passThreshold,
    deterministic: definition.deterministic,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "unknown error";
  }
  const text = typeof error === "string" ? error : String(error);
  return text.trim() === "" ? "unknown error" : text;
}

/** An outcome-supplied scope wins; otherwise the definition's, if any. */
function resolveScope(
  definition: ResolvedScoreDefinition,
  scope: ScoreResult["scope"] | undefined
): ScoreResult["scope"] | undefined {
  return scope ?? definition.scope;
}

/** Fields every non-scored row carries: the model it would have used, and scope. */
function annotations(
  definition: ResolvedScoreDefinition,
  scope: ScoreResult["scope"] | undefined
): Partial<ScoreResult> {
  const resolved = resolveScope(definition, scope);
  return {
    ...(definition.model ? { model: definition.model } : {}),
    ...(resolved ? { scope: resolved } : {}),
  };
}

/**
 * A scorer that blew up. NEVER a low score: a crashed judge reporting `0` is
 * indistinguishable from a judge that ran and disagreed. Whether this fails the
 * iteration is the gate engine's decision, read off the definition's `onError`.
 */
export function errorScoreResult(
  definition: ResolvedScoreDefinition,
  error: unknown,
  options?: { scope?: ScoreResult["scope"] }
): ScoreResult {
  return {
    ...baseResult(definition),
    status: "error",
    error: truncate(describeError(error), MAX_ERROR_LENGTH),
    ...annotations(definition, options?.scope),
  };
}

/**
 * Expected work that did not happen. Gating scorers fail closed on this by
 * default: an unscored gate is not a passed gate.
 */
export function skippedScoreResult(
  definition: ResolvedScoreDefinition,
  rationale?: string,
  options?: { scope?: ScoreResult["scope"] }
): ScoreResult {
  return {
    ...baseResult(definition),
    status: "skipped",
    ...(rationale
      ? { rationale: truncate(rationale, MAX_RATIONALE_LENGTH) }
      : {}),
    ...annotations(definition, options?.scope),
  };
}

/**
 * The scorer does not apply to this iteration at all. Never gates, and never
 * enters an aggregation denominator — the distinction from `skipped` that keeps
 * "3 of 4 scorers passed" honest when the fourth was never in scope.
 */
export function notApplicableScoreResult(
  definition: ResolvedScoreDefinition,
  rationale?: string,
  options?: { scope?: ScoreResult["scope"] }
): ScoreResult {
  return {
    ...baseResult(definition),
    status: "not_applicable",
    ...(rationale
      ? { rationale: truncate(rationale, MAX_RATIONALE_LENGTH) }
      : {}),
    ...annotations(definition, options?.scope),
  };
}

/**
 * Turn one scorer's raw observation into a contract verdict. The ONLY
 * sanctioned producer of a {@link ScoreResult}.
 *
 * A `scored` outcome whose value is not a finite number in [0,1] finalizes to
 * `error`, not to a clamped score. Clamping `1.5` to `1` would turn a
 * malfunctioning judge into a passing gate, which is the same failure mode as
 * treating a crash as a `0` — just pointed the other way.
 */
export function finalizeScoreResult(
  definition: ResolvedScoreDefinition,
  outcome: ScoreRawOutcome
): ScoreResult {
  if (outcome.kind === "skipped") {
    return skippedScoreResult(definition, outcome.rationale, {
      scope: outcome.scope,
    });
  }
  if (outcome.kind === "not_applicable") {
    return notApplicableScoreResult(definition, outcome.rationale, {
      scope: outcome.scope,
    });
  }

  const { value } = outcome;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return errorScoreResult(
      definition,
      `scorer returned a non-numeric value (${String(value)})`,
      { scope: outcome.scope }
    );
  }
  if (value < 0 || value > 1) {
    return errorScoreResult(
      definition,
      `scorer returned ${value}, outside the required [0,1] range`,
      { scope: outcome.scope }
    );
  }

  const model = outcome.model ?? definition.model;
  const scope = outcome.scope ?? definition.scope;
  const evidence = truncateEvidence(outcome.evidence);
  return {
    ...baseResult(definition),
    status: "scored",
    value,
    passed: scorePassed(value, definition.passThreshold),
    ...(outcome.rationale
      ? { rationale: truncate(outcome.rationale, MAX_RATIONALE_LENGTH) }
      : {}),
    ...(evidence ? { evidence } : {}),
    ...(model ? { model } : {}),
    ...(outcome.promptHash ? { promptHash: outcome.promptHash } : {}),
    ...(scope ? { scope } : {}),
  };
}

/**
 * Does the GATING evidence in this iteration's score rows say it passed?
 *
 * This is the arithmetic the score contract becomes AUTHORITATIVE with (grading
 * mode `enforce`): the inspector derives an iteration's `result` from it, and
 * the backend re-derives from the persisted rows and downgrades the iteration
 * if the two disagree. It lives here, in the contract's only sanctioned
 * derivation module, because two implementations of "did the gates hold" is
 * precisely how a hosted run and a CI gate end up disagreeing about the same
 * rows. `convex/lib/scoreContract.ts` in the backend hand-mirrors it, pinned by
 * the shared parity fixtures.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * An iteration passes when EVERY gating definition resolved, and every gating
 * definition that resolved to a verdict passed. Stated as its two failure
 * modes, which are deliberately reported separately:
 *
 *   - `disagreeingScorerIds` — a gating scorer RAN and said no. A real failure.
 *   - `unresolvedScorerIds`  — a gating scorer produced no usable verdict: no
 *     row at all, or a row whose status its own `onError`/`onSkipped` policy
 *     says must fail. ABSENCE of evidence, and it does not pass. Zero evidence
 *     never passes — that is the whole reason the resolved defaults for a
 *     gating definition are `fail`/`fail`.
 *
 * The separation is what lets one function serve both consumers. The authority
 * path (`enforce`) reads `passed` and treats an unresolved gate as a failure,
 * conservatively matching what the legacy boolean pipeline does with an
 * unscorable criterion. The SHADOW comparison reads `disagreeingScorerIds`
 * alone (see `shadowVerdictFromScores` in the inspector's `score-rows.ts`), so
 * an honest error row cannot manufacture a mismatch out of a criterion nobody
 * could score.
 *
 * ── What cannot influence it ────────────────────────────────────────────────
 *
 *   - **Advisory rows.** Only `role: "gating"` definitions are iterated at all,
 *     which is what makes the judge structurally incapable of gating rather
 *     than conventionally excluded from it.
 *   - **`not_applicable` rows.** They are excluded from every denominator —
 *     that is what the status means — so a definition whose only rows are
 *     `not_applicable` neither fails nor counts as missing.
 *   - **Rows that do not join.** The join is by `definitionHash`, like every
 *     other contract consumer: matching on `scorerId` would grade a row against
 *     whichever definition landed last when a merged iteration carries the same
 *     id under two hashes. A row whose hash matches no definition is already
 *     quarantined at ingest (`validateScorePayload`), so accepted rows always
 *     join.
 */
export function allGatingScorersPassed(
  scores: readonly ScoreResult[],
  config: EvaluationConfigSnapshot
): {
  passed: boolean;
  disagreeingScorerIds: string[];
  unresolvedScorerIds: string[];
} {
  const disagreeingScorerIds: string[] = [];
  const unresolvedScorerIds: string[] = [];

  for (const definition of config.definitions) {
    if (definition.role !== "gating") continue;
    const hash = definitionHash(definition);
    const joined = scores.filter((score) => score.definitionHash === hash);
    // `not_applicable` is excluded from EVERY denominator — that is what the
    // status means — so it is dropped here and NOT read as missing evidence.
    // The distinction from an absent row is the whole reason the status exists:
    // "this scorer does not apply to this iteration" is an answer, and "nobody
    // scored this gate" is not.
    const rows = joined.filter((score) => score.status !== "not_applicable");
    if (rows.length === 0) {
      if (joined.length === 0) unresolvedScorerIds.push(definition.scorerId);
      continue;
    }
    let failed = false;
    let unresolved = false;
    for (const row of rows) {
      if (row.status === "scored") {
        // RE-DERIVED AGAINST THE DEFINITION, never read off the row. A row's
        // `passed` is only checked to be internally consistent with the row's
        // OWN `passThreshold`, which is a field the row supplies; the
        // threshold with authority is the one on the definition this row
        // joined to, because that is what the definition hash was taken over.
        // See the mirror in `convex/lib/scoreContract.ts` for the full note.
        // Conservative in BOTH directions: the row must assert a pass AND the
        // definition's own threshold must agree.
        const passed =
          row.passed !== false &&
          typeof row.value === "number" &&
          row.value >= definition.passThreshold;
        if (!passed) failed = true;
        continue;
      }
      // `error` / `skipped`: the DEFINITION's own policy decides, so an author
      // who wrote `onError: "ignore"` gets the opt-out they asked for rather
      // than a gate this function invented.
      const policy =
        row.status === "error" ? definition.onError : definition.onSkipped;
      if (policy === "fail") unresolved = true;
    }
    if (failed) disagreeingScorerIds.push(definition.scorerId);
    else if (unresolved) unresolvedScorerIds.push(definition.scorerId);
  }

  return {
    passed:
      disagreeingScorerIds.length === 0 && unresolvedScorerIds.length === 0,
    disagreeingScorerIds,
    unresolvedScorerIds,
  };
}
