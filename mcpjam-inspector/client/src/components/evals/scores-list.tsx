import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  MinusCircle,
  XCircle,
} from "lucide-react";
import type {
  EvaluationConfigSnapshot,
  ResolvedScoreDefinition,
  ScoreResult,
} from "@mcpjam/sdk/contract";
import {
  definitionHash,
  evaluationConfigSnapshotSchema,
  scoreResultSchema,
} from "@mcpjam/sdk/contract";
import {
  EVAL_FAILED_BADGE_STRONG_CLASS,
  EVAL_PASSED_BADGE_STRONG_CLASS,
} from "./constants";
import type { EvalIteration } from "./types";

/**
 * Read the persisted score rows off `iteration.metadata.scores`, defensively.
 *
 * Validated ROW BY ROW rather than as a whole array — deliberately different
 * from the public v1 DTO, which is all-or-nothing. That boundary is a trust
 * boundary and must never emit partially-trusted data; this is a dashboard,
 * where showing four verdicts and dropping a fifth malformed one is strictly
 * more useful to an operator than showing nothing at all.
 *
 * Returns `null` when there is nothing to render, so the caller hides the
 * section.
 */
export function parseIterationScores(
  metadata: EvalIteration["metadata"],
): ScoreResult[] | null {
  if (!metadata) return null;
  const raw = (metadata as Record<string, unknown>).scores;
  if (!Array.isArray(raw)) return null;
  const rows: ScoreResult[] = [];
  for (const item of raw) {
    const parsed = scoreResultSchema.safeParse(item);
    if (parsed.success) rows.push(parsed.data as ScoreResult);
  }
  return rows.length > 0 ? rows : null;
}

/**
 * Read the definition snapshot off `iteration.metadata.evaluationConfig`.
 *
 * Without it the rows are UN-JOINABLE: `role`, `onError` and `onSkipped` live
 * only on definitions, so a score cannot be told apart as gating or advisory.
 * The renderer degrades honestly in that case rather than guessing.
 */
export function parseEvaluationConfig(
  metadata: EvalIteration["metadata"],
): EvaluationConfigSnapshot | null {
  if (!metadata) return null;
  const parsed = evaluationConfigSnapshotSchema.safeParse(
    (metadata as Record<string, unknown>).evaluationConfig,
  );
  return parsed.success ? (parsed.data as EvaluationConfigSnapshot) : null;
}

/**
 * Whether the backend downgraded this iteration's verdict because its gating
 * score evidence was malformed. Surfaced prominently: this path is otherwise
 * silent by construction — the verdict simply flips — and an operator staring
 * at an unexplained failure deserves the reason.
 */
export function parseScoreIntegrity(
  metadata: EvalIteration["metadata"],
): "score_integrity_invalid" | null {
  if (!metadata) return null;
  const raw = (metadata as Record<string, unknown>).scoreIntegrity;
  return raw === "score_integrity_invalid" ? raw : null;
}

type JoinedScore = {
  score: ScoreResult;
  definition: ResolvedScoreDefinition | null;
};

/**
 * Join results to definitions on `definitionHash` — never on `scorerId`.
 *
 * The hash is RECOMPUTED from each definition rather than trusted from the
 * payload, which is what makes the join meaningful: a row whose stamped hash
 * does not match any definition as actually stored was produced under a
 * different configuration, and rendering it against the current one would be
 * the exact substitution the integrity model exists to catch. It renders as
 * unresolved instead. The digest is pure and sync (that is why the contract
 * uses @noble/hashes rather than async Web Crypto), and a snapshot holds a
 * handful of definitions, so this is cheap.
 */
function joinScores(
  scores: ScoreResult[],
  config: EvaluationConfigSnapshot | null,
): JoinedScore[] {
  const byHash = new Map<string, ResolvedScoreDefinition>();
  for (const definition of config?.definitions ?? []) {
    byHash.set(definitionHash(definition), definition);
  }
  return scores.map((score) => ({
    score,
    definition: byHash.get(score.definitionHash) ?? null,
  }));
}

function isGating(joined: JoinedScore): boolean {
  return joined.definition?.role === "gating";
}

/**
 * Does this row belong in a "N / M gating scores passed" count?
 *
 * Deliberately NOT `isGating`, and the difference is the whole point of two
 * predicates:
 *
 *   - an UNJOINABLE row counts, even though it renders in its own section — it
 *     fails closed everywhere else, and leaving it out would read
 *     "2 / 2 checks passed" beside a failed iteration;
 *   - a joined gating row that came back `not_applicable` does NOT count, even
 *     though it renders under "Gating" — exclusion from every denominator is
 *     exactly what distinguishes it from `skipped`.
 *
 * Every count in this file goes through here, so the header and the compact
 * chip cannot disagree about the same iteration.
 */
function countsTowardGate(joined: JoinedScore): boolean {
  if (joined.definition === null) return true;
  if (joined.definition.role !== "gating") return false;
  return joined.score.status !== "not_applicable";
}

/** Does this row count against the gate? Mirrors the SDK's `scoresPassed`. */
function failsGate(joined: JoinedScore): boolean {
  if (!joined.definition) return true; // unjoinable ⇒ fails closed
  if (joined.definition.role !== "gating") return false;
  switch (joined.score.status) {
    case "scored":
      return joined.score.passed !== true;
    case "error":
      return joined.definition.onError === "fail";
    case "skipped":
      return joined.definition.onSkipped === "fail";
    case "not_applicable":
      return false;
    default:
      return true;
  }
}

/** Single-row helpers for callers (e.g. the row chip) that hold one score. */
function joinOne(
  score: ScoreResult,
  config: EvaluationConfigSnapshot | null,
): JoinedScore {
  return joinScores([score], config)[0];
}

/** Whether this score decides the verdict — see {@link countsTowardGate}. */
export function isGatingScore(
  score: ScoreResult,
  config: EvaluationConfigSnapshot | null,
): boolean {
  return countsTowardGate(joinOne(score, config));
}

export function scoreFailsGate(
  score: ScoreResult,
  config: EvaluationConfigSnapshot | null,
): boolean {
  return failsGate(joinOne(score, config));
}

function statusBadge(joined: JoinedScore) {
  const { status, passed } = joined.score;
  // An unjoinable row is treated as failing everywhere else; rendering the
  // `passed` it happens to carry would put a green PASS chip on the one row
  // whose verdict nobody can verify.
  if (joined.definition === null) {
    return {
      label: "UNRESOLVED",
      icon: AlertTriangle,
      className:
        "bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30",
    };
  }
  if (status === "scored") {
    return passed
      ? { label: "PASS", icon: CheckCircle2, className: EVAL_PASSED_BADGE_STRONG_CLASS }
      : { label: "FAIL", icon: XCircle, className: EVAL_FAILED_BADGE_STRONG_CLASS };
  }
  if (status === "error") {
    return {
      label: "ERROR",
      icon: AlertTriangle,
      className:
        "bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30",
    };
  }
  if (status === "skipped") {
    return {
      label: "SKIPPED",
      icon: CircleSlash,
      className:
        "bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20",
    };
  }
  return {
    label: "N/A",
    icon: MinusCircle,
    className: "bg-muted text-muted-foreground border border-border/40",
  };
}

function formatValue(score: ScoreResult): string | null {
  if (score.status !== "scored" || score.value === undefined) return null;
  // Two decimals, trailing zeros trimmed: a 0/1 predicate reads "1", a judge
  // reads "0.82".
  const value = Number(score.value.toFixed(2));
  const threshold = Number(score.passThreshold.toFixed(2));
  return `${value} / ${threshold}`;
}

/** The header badge's three tones. `none` is muted: it asserts nothing. */
const SUMMARY_TONE = {
  passed: { icon: CheckCircle2, className: EVAL_PASSED_BADGE_STRONG_CLASS },
  failed: { icon: XCircle, className: EVAL_FAILED_BADGE_STRONG_CLASS },
  none: {
    icon: MinusCircle,
    className: "bg-muted text-muted-foreground border border-border/40",
  },
} as const;

/**
 * Render the per-iteration score gate.
 *
 * Advisory rows are visually separated from gating ones rather than merely
 * annotated: the single most misleading thing this view could do is let a red
 * advisory judge read as the reason a run failed.
 */
export function ScoresList({
  scores,
  evaluationConfig,
  integrity,
}: {
  scores: ScoreResult[];
  evaluationConfig: EvaluationConfigSnapshot | null;
  integrity?: "score_integrity_invalid" | null;
}) {
  // An integrity-invalid iteration whose rows were ALL quarantined still
  // renders: the warning below is the only explanation an operator will get
  // for the failed verdict.
  if (scores.length === 0 && integrity !== "score_integrity_invalid") {
    return null;
  }
  const joined = joinScores(scores, evaluationConfig);
  const gating = joined.filter(isGating);
  const advisory = joined.filter(
    (row) => row.definition !== null && !isGating(row),
  );
  const unjoinable = joined.filter((row) => row.definition === null);

  // The SECTIONS above group rows for a reader; the count below is the verdict,
  // and the two memberships are not the same set. Counting the "Gating" section
  // instead would put an out-of-scope `not_applicable` row in the denominator
  // here while the compact chip left it out — the same iteration summarized two
  // ways, in two places on the same screen.
  const counted = joined.filter(countsTowardGate);
  const countedFailures = counted.filter(failsGate).length;
  // An integrity downgrade means the backend could not verify this iteration's
  // gating evidence and flipped its verdict. The surviving rows may all read
  // green — they are the ones that DID validate — so summarizing them as a
  // pass would contradict the run's own result.
  const integrityInvalid = integrity === "score_integrity_invalid";
  // THREE states, not two. An iteration with nothing to gate on has neither
  // met a gate nor missed one, and a binary badge has to lie in one direction
  // or the other: a green check claims a threshold was cleared, a red cross
  // reports a regression that did not happen. It renders neutral instead.
  const summary: { tone: keyof typeof SUMMARY_TONE; label: string } =
    integrityInvalid
      ? { tone: "failed", label: "score evidence did not verify" }
      : counted.length === 0
        ? { tone: "none", label: "no gating scores" }
        : {
            tone: countedFailures === 0 ? "passed" : "failed",
            label: `${counted.length - countedFailures} / ${counted.length} gating scores passed`,
          };
  const tone = SUMMARY_TONE[summary.tone];
  const SummaryIcon = tone.icon;

  return (
    <div
      role="region"
      aria-label="Scores"
      className="space-y-2 rounded-md border border-border/40 bg-muted/10 p-3"
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Scores
        </div>
        <div
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone.className}`}
        >
          <SummaryIcon className="h-3 w-3 shrink-0" aria-hidden />
          {summary.label}
        </div>
      </div>

      {integrity === "score_integrity_invalid" ? (
        <div className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            This iteration&rsquo;s verdict was downgraded at ingest: its gating
            score evidence did not verify. The reported result is not
            trustworthy on its own.
          </span>
        </div>
      ) : null}

      {evaluationConfig === null ? (
        <div className="rounded border border-border/40 bg-background/40 p-2 text-[11px] text-muted-foreground">
          No evaluation config was recorded for this iteration, so these scores
          cannot be resolved to their definitions — whether each one gates is
          unknown.
        </div>
      ) : null}

      <ScoreGroup title="Gating" rows={gating} keyPrefix="gating" />
      <ScoreGroup title="Advisory" rows={advisory} keyPrefix="advisory" />
      <ScoreGroup
        title="Unresolved (no matching definition)"
        rows={unjoinable}
        keyPrefix="unjoinable"
      />
    </div>
  );
}

function ScoreGroup({
  title,
  rows,
  keyPrefix,
}: {
  title: string;
  rows: JoinedScore[];
  keyPrefix: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-medium text-muted-foreground">
        {title}
      </div>
      <ul className="space-y-1.5">
        {rows.map((row, index) => (
          <ScoreRow key={`${keyPrefix}-${index}`} row={row} />
        ))}
      </ul>
    </div>
  );
}

function ScoreRow({ row }: { row: JoinedScore }) {
  const badge = statusBadge(row);
  const Icon = badge.icon;
  const failing = failsGate(row);
  const value = formatValue(row.score);
  const label = row.definition?.label ?? row.score.scorerId;

  return (
    <li
      className={`rounded border ${
        failing
          ? "border-red-500/40 bg-red-500/5"
          : "border-border/40 bg-background/40"
      }`}
    >
      <details className="group" open={failing}>
        <summary className="flex cursor-pointer list-none items-start gap-2 p-2 [&::-webkit-details-marker]:hidden">
          <span
            className={`mt-0.5 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.className}`}
          >
            <Icon className="h-3 w-3" aria-hidden />
            {badge.label}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-xs font-medium">{label}</span>
              <span className="truncate text-[11px] text-muted-foreground">
                {row.score.scorerId}
              </span>
              {value ? (
                <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {value}
                </span>
              ) : null}
              {row.definition?.deterministic === false ? (
                <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  non-deterministic
                </span>
              ) : null}
            </span>
          </span>
        </summary>
        <div className="space-y-1 px-2 pb-2 text-[11px] text-muted-foreground">
          {row.score.error ? (
            <div className="text-amber-700 dark:text-amber-300">
              {row.score.error}
            </div>
          ) : null}
          {row.score.rationale ? <div>{row.score.rationale}</div> : null}
          {row.score.evidence?.length ? (
            <ul className="list-disc space-y-0.5 pl-4">
              {row.score.evidence.map((entry, index) => (
                <li key={index}>{entry}</li>
              ))}
            </ul>
          ) : null}
          {row.definition === null ? (
            <div>
              No definition in this run&rsquo;s snapshot matches{" "}
              <code className="font-mono">{row.score.scorerId}</code>, so this
              row is treated as failing the gate.
            </div>
          ) : null}
          {row.score.model ? <div>model: {row.score.model}</div> : null}
        </div>
      </details>
    </li>
  );
}
