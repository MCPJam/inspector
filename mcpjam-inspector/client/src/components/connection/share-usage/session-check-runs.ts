/**
 * Reading `chatSessionChecks` rows on the session-detail surface.
 *
 * The table holds BOTH graders' rows — the deterministic checks evaluator and
 * the LLM goal-completion judge — and the per-session Checks panel owns only
 * the first kind. Everything needed to tell them apart, name a verdict, and
 * order a re-grade history lives here rather than in the component, so the
 * classification rule has one definition and a unit test.
 */

import type { Predicate } from "@/shared/eval-matching";
import { formatCriterion, isKnownPredicateKind } from "@/shared/predicate-kinds";

/** Which grader produced a row. Mirrors the backend `runKind` column. */
export type CheckRunKind = "checks" | "judge";

export type CheckRunStatus = "running" | "completed" | "failed";

/**
 * One `chatSessionChecks` row as it arrives over the wire.
 *
 * Deliberately loose: the Convex query is called by string path (no generated
 * types on this side), the row shape differs by producer, and every field this
 * module reads is validated or defaulted at the point of use. `source` is a
 * bare string so a value this build predates — `production`, when WS1 lands —
 * renders as an unknown origin rather than crashing the panel.
 */
export interface SessionCheckRun {
  _id?: string;
  _creationTime?: number;
  checkRunId?: string;
  source?: string;
  runKind?: string;
  status?: string;
  error?: string;
  generation?: number;
  definitionSnapshot?: {
    setKind?: string;
    criteria?: Array<{ id?: string; label?: string; predicate?: Predicate }>;
    predicates?: Predicate[];
  };
  criterionResults?: Array<{
    criterionId?: string;
    passed?: boolean;
    reason?: string;
  }>;
  predicateResults?: Array<{
    predicate?: Predicate;
    passed?: boolean;
    reason?: string;
  }>;
  createdAt?: number;
  completedAt?: number;
}

/** One verdict row, normalized across the two result shapes. */
export interface CheckVerdict {
  /** React key — stable within a run, not globally unique. */
  key: string;
  name: string;
  passed: boolean;
  reason: string;
}

/**
 * Which grader produced this row.
 *
 * `runKind` is authoritative when present. It is absent only on rows written
 * before the column shipped, and the fallbacks below exist so the panel works
 * against a deployment where the backend hasn't been promoted yet — a real
 * window, since the two repos ship independently.
 *
 * The legacy fallbacks, in order of how much they actually know:
 *
 *  1. The producer-minted `checkRunId` shape. Deterministic per producer
 *     (`swarmchecks:<id>`, `swarm_judge:<id>:<gen>`,
 *     `<id>_on_demand_judge_<ts>`), so it identifies the writer outright.
 *  2. Snapshot shape, last. A judge row carries `{setKind: 'ad_hoc',
 *     predicates: []}` and no `criteria`. This is the weakest rule — a checks
 *     run over an empty predicate set is structurally identical — but it only
 *     runs for rows no id rule matched, and misfiling an empty row costs
 *     nothing: it has no verdicts to show either way.
 *
 * Never infers from `goalCompletionResult` presence: a judge row that FAILED
 * or is still running carries none, which is precisely the row a
 * presence-based rule would misclassify into an empty duplicate group.
 */
export function classifyCheckRun(run: SessionCheckRun): CheckRunKind {
  if (run.runKind === "checks" || run.runKind === "judge") return run.runKind;

  const id = run.checkRunId ?? "";
  if (id.startsWith("swarmchecks:")) return "checks";
  if (id.startsWith("swarm_judge:")) return "judge";
  if (/_on_demand_judge_\d+$/.test(id)) return "judge";

  const snapshot = run.definitionSnapshot;
  const predicateCount = snapshot?.predicates?.length ?? 0;
  if (predicateCount === 0 && snapshot?.criteria === undefined) return "judge";
  return "checks";
}

/** Rows this panel owns. */
export function isChecksRun(run: SessionCheckRun): boolean {
  return classifyCheckRun(run) === "checks";
}

/**
 * When a run happened. `createdAt` is what the producers stamp; `_creationTime`
 * is Convex's own and only backstops a row missing the explicit field.
 */
function runTimestamp(run: SessionCheckRun): number {
  return run.createdAt ?? run._creationTime ?? 0;
}

/**
 * Newest first.
 *
 * The query returns oldest-first, and re-grades accumulate rows on the paths
 * that mint a fresh `checkRunId` per request. The verdict a reader wants is
 * the current one, so it leads; history follows.
 */
export function sortCheckRunsNewestFirst(
  runs: readonly SessionCheckRun[]
): SessionCheckRun[] {
  return [...runs].sort((a, b) => runTimestamp(b) - runTimestamp(a));
}

/** Human origin label for the run's trigger. */
const SOURCE_LABELS: Record<string, string> = {
  swarm: "Swarm",
  on_demand: "On demand",
  scheduled: "Scheduled",
  eval: "Eval",
  // Not written by anything yet — WS1's production-scoring path will. Listed
  // now so that path lights up here without a UI change.
  production: "Production",
};

export function checkRunOriginLabel(run: SessionCheckRun): string {
  const source = run.source ?? "";
  return SOURCE_LABELS[source] ?? (source || "Unknown");
}

/**
 * Name one criterion result, using the snapshot the run was graded against.
 *
 * The raw-id fallback is deliberate and load-bearing: a result whose check no
 * longer appears in the snapshot is still a real verdict with a real reason,
 * and inventing a friendly name for it would be a guess. `formatCriterion` has
 * no id to fall back to, so the escape hatch lives here — the same split the
 * run scorecard and the Insights findings use.
 */
function criterionName(
  criterionId: string,
  criteria?: Array<{ id?: string; label?: string; predicate?: Predicate }>
): string {
  const entry = criteria?.find((c) => c?.id === criterionId);

  // The author's own words win, and they win BEFORE the predicate is
  // consulted — a snapshot entry can carry a label without a readable
  // predicate, and falling through to the raw id there would throw away the
  // one human-written name we have.
  const label = entry?.label?.trim();
  if (label) return label;

  // An unknown kind must not reach `formatCriterion`: it indexes
  // `PREDICATE_KIND_LABELS` directly, so a prototype-key discriminator would
  // come back as an inherited object and throw when rendered.
  if (!entry?.predicate || !isKnownPredicateKind(entry.predicate.type)) {
    return criterionId;
  }
  // Still guarded: `formatCriterion` can return an empty string for a
  // malformed payload, and a blank cell names nothing.
  return formatCriterion({ predicate: entry.predicate }) || criterionId;
}

/**
 * Flatten a run's verdicts into one shape, whichever result array it carries.
 *
 * `criterionResults` is the rubric path (id-keyed, correlates back to
 * `definitionSnapshot.criteria`); `predicateResults` is the suite-shaped path
 * (positional, carries its own predicate). A row that is still `running`, or
 * that failed before producing verdicts, has neither and yields `[]` — the
 * caller renders the run's status, not an empty list of checks.
 */
export function toCheckVerdicts(run: SessionCheckRun): CheckVerdict[] {
  const criteria = run.definitionSnapshot?.criteria;

  // Gated on LENGTH, not presence: a row carrying `criterionResults: []`
  // alongside populated `predicateResults` would otherwise claim this branch
  // and report no verdicts at all, rendering a completed run as empty. No
  // producer writes that shape today, but this module reads wire data and the
  // fallback costs nothing to keep reachable.
  if (Array.isArray(run.criterionResults) && run.criterionResults.length > 0) {
    return run.criterionResults.flatMap((result, index) => {
      if (typeof result?.passed !== "boolean") return [];
      const criterionId = result.criterionId ?? "";
      return [
        {
          // Index-prefixed so the key stays unique even if two results share a
          // criterionId. Rubric ids are validated unique at the write
          // boundary, so this is belt-and-braces against malformed rows.
          key: `${index}-${criterionId || "criterion"}`,
          name: criterionName(criterionId, criteria),
          passed: result.passed,
          reason: result.reason ?? "",
        },
      ];
    });
  }

  if (Array.isArray(run.predicateResults) && run.predicateResults.length > 0) {
    return run.predicateResults.flatMap((result, index) => {
      if (typeof result?.passed !== "boolean" || !result.predicate) return [];
      const type = result.predicate.type;
      return [
        {
          key: `predicate-${index}`,
          // Same guard as `criterionName`: an unknown kind degrades to its raw
          // discriminator rather than to whatever the prototype chain returns.
          name: isKnownPredicateKind(type)
            ? formatCriterion({ predicate: result.predicate }) || type
            : type,
          passed: result.passed,
          reason: result.reason ?? "",
        },
      ];
    });
  }

  return [];
}
