/**
 * Public projection of the backend's run diff.
 *
 * Extracted from `evals.ts` for the same reason `eval-score-projection.ts` is:
 * its test must exercise the REAL function. A test that re-implements a
 * whitelist proves only that it agrees with itself, and what this whitelist
 * guards is that internal `_storage` ids never reach a public caller.
 *
 * --- What is dropped, and why ---
 *
 * `traceBlobIds` — arrays of `Id<'_storage'>` — appear on BOTH per-case sides
 * of the internal diff. They are handles to the raw trace blobs: not secret in
 * themselves, but a storage id is an internal addressing detail that no public
 * contract should hand out, and once published it can never be withdrawn.
 * `iterationIds` stay: they are already public on the iterations endpoint and
 * are how a caller drills into a case.
 *
 * Every field is listed EXPLICITLY. A passthrough with a delete-list inverts
 * the failure mode — a new internal field would ship publicly by default, and
 * the next `traceBlobIds` would leak on the day it was added rather than fail
 * a test.
 *
 * --- Renames on the wire ---
 *
 * The internal `scores` is run-summary counters, and it collides by name with
 * score-contract data. It is `passSummary` here; "scores" appears on this wire
 * only inside `scoreContract` / `scoreDeltas`.
 */

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericDiff(value: unknown): Rec {
  const source = isRecord(value) ? value : {};
  const num = (key: string): number | null =>
    typeof source[key] === "number" ? (source[key] as number) : null;
  return {
    base: num("base"),
    compare: num("compare"),
    delta: num("delta"),
    percentDelta: num("percentDelta"),
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function boolOf(value: unknown): boolean {
  return value === true;
}

function integrityOf(value: unknown): "valid" | "invalid" | null {
  return value === "valid" || value === "invalid" ? value : null;
}

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function scoreContractSide(value: unknown): Rec {
  const side = isRecord(value) ? value : {};
  return {
    evaluationConfigHash: strOrNull(side.evaluationConfigHash),
    scoreIntegrity: integrityOf(side.scoreIntegrity),
    scoredIterations: countOf(side.scoredIterations),
    quarantinedIterations: countOf(side.quarantinedIterations),
  };
}

function scoreContract(value: unknown): Rec {
  const contract = isRecord(value) ? value : {};
  const scorers = Array.isArray(contract.scorers) ? contract.scorers : [];
  return {
    base: scoreContractSide(contract.base),
    compare: scoreContractSide(contract.compare),
    evaluationConfigChanged: boolOf(contract.evaluationConfigChanged),
    scorers: scorers.filter(isRecord).map((scorer) => ({
      scorerId: str(scorer.scorerId),
      gating: boolOf(scorer.gating),
      deterministic: boolOf(scorer.deterministic),
      definitionChanged: boolOf(scorer.definitionChanged),
      passRate: numericDiff(scorer.passRate),
      meanValue: numericDiff(scorer.meanValue),
      errorCount: {
        base: countOf(
          isRecord(scorer.errorCount) ? scorer.errorCount.base : undefined,
        ),
        compare: countOf(
          isRecord(scorer.errorCount) ? scorer.errorCount.compare : undefined,
        ),
      },
    })),
  };
}

const SCORE_STATUSES = new Set([
  "scored",
  "error",
  "skipped",
  "not_applicable",
]);

function caseScoreSide(value: unknown): Rec | null {
  if (!isRecord(value)) return null;
  const status = SCORE_STATUSES.has(str(value.status))
    ? str(value.status)
    : "not_applicable";
  return {
    status,
    value: numOrNull(value.value),
    passed: typeof value.passed === "boolean" ? value.passed : null,
  };
}

function scoreDeltas(value: unknown): Rec[] {
  const rows = Array.isArray(value) ? value : [];
  return rows.filter(isRecord).map((row) => ({
    scorerId: str(row.scorerId),
    gating: boolOf(row.gating),
    deterministic: boolOf(row.deterministic),
    definitionChanged: boolOf(row.definitionChanged),
    base: caseScoreSide(row.base),
    compare: caseScoreSide(row.compare),
    value: numericDiff(row.value),
  }));
}

const CASE_OUTCOMES = new Set(["passed", "failed", "absent"]);

/** Per-case side. `traceBlobIds` is NOT read here — that is the point. */
function caseSide(value: unknown): Rec {
  const side = isRecord(value) ? value : {};
  const iterationIds = Array.isArray(side.iterationIds)
    ? side.iterationIds.filter((id): id is string => typeof id === "string")
    : [];
  return {
    outcome: CASE_OUTCOMES.has(str(side.outcome))
      ? str(side.outcome)
      : "absent",
    iterationIds,
    representativeIterationId: strOrNull(side.representativeIterationId),
    error: strOrNull(side.error),
  };
}

const CASE_STATUSES = new Set([
  "unchanged_passed",
  "unchanged_failed",
  "regressed",
  "fixed",
  "new_case",
  "removed_case",
  "changed",
]);

function runSide(value: unknown): Rec {
  const run = isRecord(value) ? value : {};
  const summary = isRecord(run.summary) ? run.summary : null;
  const environment = isRecord(run.environment) ? run.environment : null;
  return {
    id: str(run.id),
    runNumber: countOf(run.runNumber),
    result: str(run.result),
    createdAt: countOf(run.createdAt),
    completedAt: numOrNull(run.completedAt),
    summary: summary
      ? {
          total: countOf(summary.total),
          passed: countOf(summary.passed),
          failed: countOf(summary.failed),
          passRate: countOf(summary.passRate),
        }
      : null,
    ...(environment
      ? {
          environment: {
            id: str(environment.id ?? environment.environmentId),
            name: strOrNull(environment.name),
          },
        }
      : {}),
    ...(typeof run.effectiveModelId === "string"
      ? { effectiveModelId: run.effectiveModelId }
      : {}),
    ...(run.modelSource === "client_default" || run.modelSource === "override"
      ? { modelSource: run.modelSource }
      : {}),
  };
}

const SKILL_CHANGE_KINDS = new Set(["added", "removed", "changed"]);
const SKILL_CHANNELS = new Set(["host", "environment", "plugin", "mcp-server"]);

/**
 * One side's fingerprint of a skill: hashes plus, when the run recorded one,
 * the revision number. Whitelisted field by field like everything else here —
 * the pinned-skill metadata is a wide internal shape and only these four are
 * public.
 */
function skillSide(value: unknown): Rec | null {
  if (!isRecord(value)) return null;
  return {
    contentHash: str(value.contentHash),
    ...(typeof value.aggregateHash === "string"
      ? { aggregateHash: value.aggregateHash }
      : {}),
    ...(typeof value.versionNumber === "number"
      ? { versionNumber: value.versionNumber }
      : {}),
    ...(typeof value.serverSkillVersionNumber === "number"
      ? { serverSkillVersionNumber: value.serverSkillVersionNumber }
      : {}),
  };
}

/**
 * Which skills changed between the two runs — the configuration attribution
 * that explains a case-level regression.
 *
 * `null` passes through as `null` rather than becoming an empty section: the
 * backend uses it to mean "neither run recorded skills", and flattening that
 * into `{changes: []}` would tell a public caller no skills were involved.
 *
 * The internal shape carries no `_storage` ids (skill bodies and files live in
 * the pin stores, joined by hash elsewhere), so nothing here needs dropping —
 * but it is still a whitelist, for the same reason the rest of the file is.
 */
function skills(value: unknown): Rec | null {
  if (!isRecord(value)) return null;
  const base = isRecord(value.base) ? value.base : {};
  const compare = isRecord(value.compare) ? value.compare : {};
  const changes = Array.isArray(value.changes) ? value.changes : [];
  return {
    base: { excluded: boolOf(base.excluded), count: countOf(base.count) },
    compare: {
      excluded: boolOf(compare.excluded),
      count: countOf(compare.count),
    },
    changes: changes.filter(isRecord).map((row) => {
      const baseSide = skillSide(row.base);
      const compareSide = skillSide(row.compare);
      return {
        key: str(row.key),
        name: str(row.name),
        ...(typeof row.modelRef === "string" ? { modelRef: row.modelRef } : {}),
        channels: (Array.isArray(row.channels) ? row.channels : [])
          .filter((c): c is string => typeof c === "string")
          .filter((c) => SKILL_CHANNELS.has(c)),
        kind: SKILL_CHANGE_KINDS.has(str(row.kind)) ? str(row.kind) : "changed",
        ...(typeof row.renamedFrom === "string"
          ? { renamedFrom: row.renamedFrom }
          : {}),
        ...(baseSide ? { base: baseSide } : {}),
        ...(compareSide ? { compare: compareSide } : {}),
        ...(typeof row.versionDelta === "string"
          ? { versionDelta: row.versionDelta }
          : {}),
      };
    }),
    unchangedCount: countOf(value.unchangedCount),
  };
}

export type RunCompareBaseline = {
  policy:
    | "previous_completed"
    | "previous_completed_same_environment"
    | "run"
    | "commit_sha";
  baseRunId: string;
  /** Echoed back for the `commit_sha` policy only. */
  baseCommitSha?: string;
  /**
   * Present ONLY when uniqueness could not be established — the SHA matched
   * several eligible runs, or the bounded lookup saturated so older eligible
   * ones may exist beyond it. Absent means unambiguous.
   */
  matchCount?: number;
  /**
   * `matchCount` is a FLOOR, not a total — including when it reads 1. Always
   * rendered next to its count: a truncated count shown alone claims a
   * uniqueness nobody checked.
   */
  matchCountTruncated?: boolean;
};

/**
 * Project the internal diff into the public compare DTO.
 *
 * `baseline` is passed separately because it is the ACTION's answer, not the
 * diff's: the diff was handed two runs and does not know which policy chose
 * one of them.
 */
export function toRunCompareDto(
  diff: unknown,
  baseline: RunCompareBaseline,
): Rec {
  const source = isRecord(diff) ? diff : {};
  const suite = isRecord(source.suite) ? source.suite : {};
  const metrics = isRecord(source.metrics) ? source.metrics : {};
  // The internal name is `scores`; see the module comment for why it is not
  // that here.
  const passSummary = isRecord(source.scores) ? source.scores : {};
  const cases = Array.isArray(source.cases) ? source.cases : [];

  return {
    suite: { id: str(suite.id), name: str(suite.name) },
    baseline,
    baseRun: runSide(source.baseRun),
    compareRun: runSide(source.compareRun),
    passSummary: {
      passRatePercent: numericDiff(passSummary.passRatePercent),
      total: numericDiff(passSummary.total),
      passed: numericDiff(passSummary.passed),
      failed: numericDiff(passSummary.failed),
    },
    metrics: {
      wallDurationMs: numericDiff(metrics.wallDurationMs),
      totalTokens: numericDiff(metrics.totalTokens),
      estimatedCostUsd: numericDiff(metrics.estimatedCostUsd),
    },
    scoreContract: scoreContract(source.scoreContract),
    skills: skills(source.skills),
    cases: cases.filter(isRecord).map((row) => ({
      caseKey: str(row.caseKey),
      title: str(row.title),
      status: CASE_STATUSES.has(str(row.status)) ? str(row.status) : "changed",
      configChanged: boolOf(row.configChanged),
      evaluationConfigChanged: boolOf(row.evaluationConfigChanged),
      scoreDeltas: scoreDeltas(row.scoreDeltas),
      base: caseSide(row.base),
      compare: caseSide(row.compare),
    })),
  };
}
