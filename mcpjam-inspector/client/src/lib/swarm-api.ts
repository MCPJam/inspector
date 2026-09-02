/**
 * Swarm (journey-execution) client contract — the ONE place the Swarms surface
 * reaches the backend.
 *
 * Centralizes: (1) the Inspector REST launch call (`POST /api/web/swarm/…`),
 * (2) the project-scoped Convex query NAMES the UI subscribes to (Convex
 * codegen doesn't run in the inspector, so these are string-keyed `as any`
 * reads — keeping the names here stops them scattering through the component),
 * and (3) the response DTOs those reads/writes return. Mirrors the backend
 * `convex/journeyExecution/*` + `convex/{personas,journeys,journeyRuns}` by
 * hand (two-repo layout).
 */

import { authFetch } from "@/lib/session-token";
import { WebApiError } from "@/lib/apis/web/base";
import type { NormalizedError } from "@mcpjam/sdk/browser";
import { isNormalizedError } from "@mcpjam/sdk/browser";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";
import type { SwarmStreamEvent } from "@/shared/swarm-stream-events";

// ── Convex query names (string-keyed reads) ─────────────────────────────────
export const SWARM_QUERIES = {
  listPersonas: "personas:listPersonas",
  personaTrackRecord: "personas:getPersonaTrackRecord",
  listJourneysByPersona: "journeys:listJourneysByPersona",
  journeyRollup: "journeys:getJourneyRollup",
  listHosts: "hosts:listHosts",
  listJourneyRuns: "journeyRuns:listJourneyRuns",
  /** Single run by id — prefer this over paging `listJourneyRuns` when the id is known. */
  getJourneyRun: "journeyRuns:getJourneyRun",
  listSessionsByJourneyRun: "journeyRuns:listSessionsByJourneyRun",
  /** Flat Sessions-tab default: all swarm sessions in the project. */
  listSessionsByProject: "journeyRuns:listSessionsByProject",
  /** Sessions-tab persona filter (narrows the project feed). */
  listSessionsByPersona: "journeyRuns:listSessionsByPersona",
  /** Sessions-tab metric strip aggregates (project-wide or persona-scoped). */
  getSwarmSessionMetrics: "journeyRuns:getSwarmSessionMetrics",
  listRunningPersonaRefIds: "journeyRuns:listRunningPersonaRefIds",
  /** Deterministic rubric scorecard for one run (run detail panel). */
  getRunScorecard: "journeyRuns:getRunScorecard",
  /** Overview tab: recent runs grouped by journey + rubric-derived findings. */
  getSwarmOverview: "journeyRuns:getSwarmOverview",
  /**
   * Deterministic anomaly candidates for ONE wave (Insights tab). Keyed on the
   * durable `swarmRunGroupId` — legacy time-clustered waves have no key and no
   * signals. Cheap (session-row denormalizations only), safe as a live
   * subscription.
   */
  getWaveSignals: "swarmWaveInsights:getWaveSignals",
  /** Lane A generated insights for one wave (null ⇒ never requested). */
  getWaveInsights: "swarmWaveInsights:getWaveInsights",
  /** Project-wide durable findings registry (joined to a wave by fingerprint). */
  listSwarmFindings: "swarmWaveInsights:listSwarmFindings",
  /** Project environments picker (env-based journeys — flag-gated UI). */
  listEnvironments: "projectEnvironments:listEnvironments",
  /**
   * Captured tool inventory behind one environment, for the create flow's
   * "Grounded on N tools" hint. Resolves through the same helper as swarm
   * generation, so N is what the prompts actually see. Returns null for an
   * unresolvable environment — the hint hides rather than erroring.
   */
  getEnvironmentToolInventory: "serverInspections:getEnvironmentToolInventory",
  /**
   * Pre-run credit estimate for the next run of a journey (flag-gated UI,
   * fetched lazily on tooltip open — never as a live subscription).
   */
  estimateJourneyRunCredits: "journeyRuns:estimateJourneyRunCredits",
  /**
   * The project's standing clustering settings, plus which tier they came
   * from. Resolved server-side through the same path the rebuild uses, so the
   * create flow's picker cannot show one thing while the automatic post-run
   * rebuild does another.
   */
  getSwarmInsightsTuning: "chatSessions:getSwarmInsightsTuning",
} as const;

// ── Convex mutation names (string-keyed writes) ─────────────────────────────
export const SWARM_MUTATIONS = {
  /** Kick off Lane A generation for a terminal wave (`force` to regenerate). */
  requestWaveInsights: "swarmWaveInsights:requestWaveInsights",
  cancelWaveInsights: "swarmWaveInsights:cancelWaveInsights",
  /** Sentry-ignore a finding; survives the finding re-firing in later waves. */
  dismissFinding: "swarmWaveInsights:dismissFinding",
  undismissFinding: "swarmWaveInsights:undismissFinding",
} as const;

// ── Convex action names (string-keyed calls) ────────────────────────────────
export const SWARM_ACTIONS = {
  /** Source-agnostic promote-dialog detail read (`convex/chatSessionPromote.ts`). */
  getChatSessionPromoteDetail: "chatSessionPromote:getChatSessionPromoteDetail",
} as const;

// ── DTOs ────────────────────────────────────────────────────────────────────

/** Terminal + in-flight states a journey run can surface in the UI. */
/**
 * A run's status AS DISPLAYED. Not identical to the stored one.
 *
 * The backend stores five statuses (`running` … `rate_limited`) and records
 * two special endings as a MARKER on `error` rather than as a status:
 * `canceled` (someone stopped it) and `stale_runner` (the runner went silent
 * and the watchdog settled it). Both leave `status: "failed"`.
 *
 * That is a deliberate backend decision — a status literal would have to be
 * threaded through `recomputeRunSummaries` and every exhaustive switch, for a
 * distinction only presentation cares about — but it means a UI reading
 * `status` alone paints a deliberate stop bright red as a failure. `stale` was
 * already in this union and NOTHING ever produced it: the chip's `case "stale"`
 * has been dead since it was written. Use `journeyRunDisplayStatus` to get one
 * of these from a run.
 */
export type JourneyRunStatus =
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "rate_limited"
  // Display-only, derived from the `error` marker. See above.
  | "canceled"
  | "stale";

export interface JourneyRunSummary {
  total: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
}

export interface JourneyHostSummary {
  hostId: string;
  /**
   * Opaque execution-target id (Project Environments). Present on fresh runs
   * (both `host:`- and `environment:`-shaped — treated as OPAQUE, never
   * parsed); absent on historical pre-environments rows. Two same-host env
   * targets produce two summary rows distinguished only by this.
   */
  targetId?: string;
  total: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
}

/**
 * Permissive mirror of one `snapshot.hosts[]` execution target — ONLY the
 * fields the UI joins on for per-target display (label + session-id identity).
 * The full pinned spec stays server-side.
 */
export interface JourneySnapshotTarget {
  hostId: string;
  hostName?: string;
  targetId?: string;
  /** Present on ENVIRONMENT-based targets; the session-id mint and env labels
   * key on this — never on `targetId`. */
  environmentRef?: { environmentId: string; name: string; revision: number };
  serverAttachmentId?: string;
}

/**
 * NOTE: a project environment row is `ProjectEnvironmentView` from
 * `@/hooks/useProjectEnvironments` — the ONE client mirror. Import it from
 * there; do not redeclare the shape here. A second copy is how
 * `pluginVersionIds` went missing and a phantom `hostName` appeared.
 */

/**
 * Aggregated goal-completion judge rollup — backend `GoalScoreSummary`
 * (`convex/lib/swarmJudge.ts`). `avgScore` averages COMPLETED verdicts only.
 */
export interface GoalScoreRollup {
  gradedCount: number;
  passedCount: number;
  avgScore: number | null;
  pendingCount?: number;
  failedCount?: number;
}

/**
 * Compact per-session judge verdict — the denormalized
 * `chatSessions.goalScore` subset (full verdict lives on the check row).
 */
export interface SessionGoalScore {
  status?: string;
  score?: number;
  passed?: boolean;
  threshold?: number;
  reason?: string;
  error?: string;
}

/**
 * One attempt's own terminal record (`journeyRunAttempts`), mirrored by hand
 * from the backend `JourneyRunAttemptDto`.
 *
 * This is the EXECUTION plane. The `chatSessions` row a swarm cell also reads
 * is the session lifecycle, and it stays `active` long after an attempt has
 * been refused — so the matrix must resolve its outcome from here, never from
 * the session status alone.
 */
export interface JourneyRunAttempt {
  chatSessionId: string | null;
  hostId: string;
  targetId: string | null;
  sessionIdx: number;
  status: "pending" | "running" | "succeeded" | "failed" | "rate_limited";
  errorCode: string | null;
  /** Human string; historical rows may still hold a raw provider payload, so
   * render through `humanizeSwarmAttemptError`. */
  errorMessage: string | null;
}

export interface JourneyRun {
  _id: string;
  status: JourneyRunStatus | string;
  /**
   * Free-form ending marker. `"canceled"` and `"stale_runner"` are the two
   * that change how a run should be PRESENTED — see `JourneyRunStatus`.
   */
  error?: string;
  summary: JourneyRunSummary;
  hostSummaries: JourneyHostSummary[];
  /** Per-attempt outcomes. Absent on runs read before the field shipped. */
  attempts?: JourneyRunAttempt[];
  /**
   * Immutable run snapshot (the full run doc rides `listJourneyRuns`). Only
   * the target-join subset is mirrored; permissive so older rows (no
   * `targetId`/`environmentRef`) stay valid.
   */
  snapshot?: {
    hosts?: JourneySnapshotTarget[];
    /**
     * Sessions the run fans out PER EXECUTION TARGET. Optional: rows written
     * before the field was renamed from `sessionsPerHost` carry the old name
     * until the backfill runs, and the running matrix already defaults to 1.
     */
    sessionsPerTarget?: number;
  };
  /** Judge rollup for this run's sessions (absent until first grading). */
  goalScoreSummary?: GoalScoreRollup;
  createdAt: number;
}

/**
 * A single synthetic session row — the backend `JourneySessionDto` returned by
 * `journeyRuns:listSessionsBy*` page items. The row identifier is `id`
 * (`s._id` under the hood). List-card fields (`messageCount`, previews,
 * persona labels) power the Swarms Sessions tab; `readiness` /
 * `goalScore` are the server-denormalized subsets the badges read.
 */
export interface JourneySessionRow {
  /** `s._id` — the id `ShareUsageThreadDetail` opens + the deep-link threadId. */
  id: string;
  chatSessionId: string;
  projectId: string;
  hostId: string;
  personaRefId?: string;
  /** Parent journey run — required for `buildSwarmSessionPath` deep links. */
  journeyRunId?: string;
  journeyRefId?: string;
  status?: string;
  modelId?: string;
  startedAt: number;
  lastActivityAt?: number;
  messageCount?: number;
  firstMessagePreview?: string;
  personaLabel?: string;
  visitorDisplayName?: string;
  synthetic?: boolean;
  /** Server-denormalized readiness subset (see `session-readiness.tsx`). */
  readiness?: {
    status?: string;
    verdict?: string;
    issueCount?: number;
  };
  /** Server-denormalized judge verdict subset (see `swarmJudge.ts` backend). */
  goalScore?: SessionGoalScore;
  /**
   * Compact deterministic rubric verdict (mirrors `chatSessions.criteria`).
   * Absent ⇒ the run carried no rubric, or the session predates grading —
   * the matrix renders no chip at all rather than a misleading 0/0.
   */
  criteria?: SessionCriteria;
}

/** Mirrors `chatSessions.criteria` in the backend schema. */
export interface SessionCriteria {
  status: "pending" | "completed" | "failed";
  generation: number;
  /** Criteria this session was CLAIMED against; present in all three states. */
  criterionIds?: string[];
  /** Present on `completed` only. */
  results?: Array<{ criterionId: string; passed: boolean }>;
  gradedAt?: number;
}

/** One row of the run scorecard — mirrors `journeyRuns.getRunScorecard`. */
export interface RunScorecardCriterion {
  criterionId: string;
  label?: string;
  /** Predicate discriminator — the fallback label when `label` is unset. */
  kind: string;
  passCount: number;
  failCount: number;
  /** Claimed but unfinished, including a runner that died mid-grade. */
  pendingCount: number;
  /** Sessions whose GRADING broke — not sessions that failed the criterion. */
  failedGradingCount: number;
}

export interface RunScorecard {
  criteria: RunScorecardCriterion[];
  sessionsTotal: number;
  sessionsGraded: number;
}

// ── Swarms Overview (`journeyRuns:getSwarmOverview`) ────────────────────────
//
// Hand-mirrored from the backend `SwarmOverview` DTO (two-repo layout). The
// field list here IS the contract — the panel's tests type their fixtures
// against these interfaces so a backend rename forces a fixture edit rather
// than silently rendering `NaN%`.

/**
 * One failing rubric criterion on a journey's LATEST run.
 *
 * `failCount` is over `sessionsGraded`, never the run's session total: grading
 * is asynchronous, so a run with 15 sessions and 4 graded reads "4 of 4", not
 * "4 of 15". Severity is NOT a field — it is derived client-side from
 * `failCount` vs `sessionsGraded`, and only when that denominator is nonzero.
 */
export interface SwarmOverviewFinding {
  criterionId: string;
  /** Author-supplied name from the run's PINNED rubric; absent ⇒ format `kind`. */
  label?: string;
  /** Predicate discriminator — the fallback label. */
  kind?: string;
  failCount: number;
  pendingCount: number;
  failedGradingCount: number;
  /** Denominator: sessions carrying a completed rubric verdict. */
  sessionsGraded: number;
  /** Consecutive runs (latest included) failing this criterion. Always ≥ 1. */
  runStreak: number;
}

/** Compact pinned execution target — mirrors backend `SwarmOverviewTarget`. */
export interface SwarmOverviewTarget {
  hostName: string;
  modelId: string;
  /** Present when the target resolved from a project environment. */
  environmentName?: string;
}

export interface SwarmOverviewRun {
  runId: string;
  journeyRefId: string;
  journeyName: string;
  /** Relaunching an archived journey throws server-side — disable Run again. */
  journeyArchived: boolean;
  personaName: string;
  createdAt: number;
  /**
   * Durable wave id, present once the launching client and backend both carry
   * it. The Overview groups on this and falls back to the `createdAt` window
   * only for runs without one, so legacy rows render exactly as before.
   */
  swarmRunGroupId?: string;
  status: string;
  summary: JourneyRunSummary;
  goalScoreSummary?: GoalScoreRollup;
  /**
   * Failing rubric criteria for this run. Today the backend populates these on
   * each journey's LATEST run in the overview window only (`[]` on older rows);
   * the Overview accordion still mounts the empty copy for those older runs.
   */
  findings: SwarmOverviewFinding[];
  /**
   * Pinned snapshot hosts (deduped, launch order). Optional so older backends
   * that omit the field still render (Client / Model columns show —).
   */
  targets?: SwarmOverviewTarget[];
}

export interface SwarmOverviewTrendPoint {
  dayStartMs: number;
  gradedCount: number;
  passedCount: number;
  passRate: number;
}

export interface SwarmOverview {
  runs: SwarmOverviewRun[];
  runsConsidered: number;
  goalCompletion: {
    gradedCount: number;
    passedCount: number;
    /** `null` when nothing in the window is graded — render "—", never 0%. */
    passRate: number | null;
    runsWithGrades: number;
    trend: SwarmOverviewTrendPoint[];
  };
}

// ── Wave signals (deterministic anomaly candidates) ─────────────────────────
//
// Hand-mirrored from `convex/lib/swarmAnomalyMiner.ts` (two-repo layout). One
// candidate = one place trouble concentrates in a wave's matrix — a tool, a
// criterion, an environment/host, a persona, or a journey. Counts, ids, and
// exemplar links are backend-computed; the client only phrases them.

export type SwarmWaveDetectorId =
  | "tool_errors"
  | "hallucinated_tool"
  | "criterion_fail"
  | "target_failures"
  | "persona_struggles"
  | "marginal_pass"
  | "turn_cap_grind"
  | "error_recovered_pass"
  | "token_outlier"
  | "latency_outlier"
  | "no_tools_used";

export interface SwarmWaveSignalCandidate {
  detector: SwarmWaveDetectorId;
  /** Identity component (toolName / criterionId / environmentId / hostId /
   * personaRefId / journeyRefId) — stable across waves; never a label. */
  subjectKind:
    | "tool"
    | "criterion"
    | "environment"
    | "host"
    | "persona"
    | "journey";
  subjectId: string;
  /** Display-only. */
  subjectLabel: string;
  affectedSessions: number;
  sliceTotal: number;
  /** Detector-specific magnitude (count, rate, median, p95…). */
  metric?: number;
  /** Same magnitude over the REST of the wave, for relative detectors. */
  waveMetric?: number;
  /** Worst-first sessions exhibiting the anomaly (bounded). */
  exemplarSessionIds: string[];
  /** Clean sessions from the same slice, newest-first (bounded). */
  contrastSessionIds: string[];
  severityScore: number;
}

/**
 * Launch outcomes for one execution target of the wave — REPORTING, not a
 * finding.
 *
 * A target that refused connections or throttled the wave has no session to
 * open and says nothing about the MCP server's tool contract, so it travels
 * beside the candidates rather than among them. `failed` and `rateLimited`
 * stay separate: a throttled wave is not a broken server.
 */
export interface SwarmWaveTargetHealth {
  subjectKind: "environment" | "host";
  subjectId: string;
  subjectLabel: string;
  attempted: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
}

/** Result of `swarmWaveInsights:getWaveSignals` (null ⇒ unknown wave id). */
export interface SwarmWaveSignals {
  candidates: SwarmWaveSignalCandidate[];
  /** Per-target launch outcomes, worst-first. Optional: a server deployed
   * before the field existed omits it. */
  targetHealth?: SwarmWaveTargetHealth[];
  sessionCount: number;
  /** Sessions with no usable readiness analysis (pending/failed/absent). */
  unanalyzedSessionCount: number;
  judgeCoverage: { graded: number; total: number };
  /** The wave session scan hit its cap; counts cover a subset. */
  truncated: boolean;
  /** Most sessions unanalyzed — treat every count as partial. */
  lowConfidence: boolean;
  /** Every run of the wave has left `running`. */
  terminal: boolean;
}

// ── Run insights (Lane A: generated explanation over the signals) ───────────
//
// Hand-mirrored from `convex/lib/swarmWaveInsightsValidators.ts`. The split
// between backend-owned and model-owned fields is the whole contract: counts,
// ids, and evidence links are computed server-side; only `rootCause`,
// `recommendation`, `confidence`, and `summary` come from a model, merged onto
// the backend rows by fingerprint. The model is deliberately given no field
// for describing the problem — the UI renders the signal's own deterministic
// sentence for that.

export interface SwarmWaveInsightCandidate {
  /** `<detector>:<subjectKind>:<subjectId>` — joins to a registry finding. */
  fingerprint: string;
  detector: SwarmWaveDetectorId | string;
  subjectKind: string;
  subjectId: string;
  subjectLabel: string;
  affectedSessions: number;
  sliceTotal: number;
  metric?: number;
  waveMetric?: number;
  /** Failing sessions the model actually read. */
  evidenceSessionIds: string[];
  /** Passing sessions from the same slice, for contrast. */
  contrastSessionIds: string[];
  /** Planned evidence that did not fit the budget. */
  evidenceTruncated: boolean;
  /** Registry lifecycle at generation time (`new`/`recurring`/`regressed`…). */
  findingStatus?: string;
  /**
   * @deprecated No longer written or rendered. The UI shows each signal's own
   * deterministic description, so a model-written restatement of it was two
   * sentences saying one thing. Present only on rows generated before that
   * change.
   */
  claim?: string;
  rootCause: string;
  recommendation: string;
  confidence: "low" | "medium" | "high";
}

export interface SwarmWaveInsights {
  summary: string;
  generatedAt: number;
  modelUsed: string;
  providerKey: string;
  /** The wave this one was compared against, when a baseline existed. */
  baselineSwarmRunGroupId?: string;
  judgeCoverage: { graded: number; total: number };
  sessionCount: number;
  unanalyzedSessionCount: number;
  truncated: boolean;
  lowConfidence: boolean;
  candidates: SwarmWaveInsightCandidate[];
  /** Signals past the narration cap — counts only, never silently dropped. */
  unnarratedCandidates: Array<{
    fingerprint: string;
    detector: string;
    subjectLabel: string;
    affectedSessions: number;
    sliceTotal: number;
  }>;
}

/**
 * Lane B — what an open-ended read of a session sample noticed that no metric
 * measures. A SIBLING of the Lane A payload, never merged into it: different
 * evidence class (model-noticed vs deterministically detected), and it may be
 * absent on a perfectly good Lane A result.
 */
export interface SwarmWaveDiscoveryFinding {
  /** `suggested_check` proposes a rubric criterion; otherwise an observation. */
  kind: "observation" | "suggested_check";
  slug: string;
  title: string;
  detail: string;
  /** Sessions the finding was drawn from (resolved backend-side). */
  sessionIds: string[];
  confidence: "low" | "medium" | "high";
  /** Present only when the named tool really appears in the wave. */
  suggestedCheck?: { type: "toolCalledAtLeastOnce"; toolName: string };
}

export interface SwarmWaveDiscovery {
  generatedAt: number;
  modelUsed: string;
  providerKey: string;
  sampledSessionIds: string[];
  findings: SwarmWaveDiscoveryFinding[];
}

/** Lifecycle envelope returned by `getWaveInsights`. */
export interface SwarmWaveInsightsDto {
  status: "pending" | "completed" | "failed";
  insights: SwarmWaveInsights | null;
  /** Absent against a backend that predates Lane B. */
  discovery?: SwarmWaveDiscovery | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: number;
}

/** A durable finding in the project registry (Sentry model). */
export interface SwarmFinding {
  findingId: string;
  fingerprint: string;
  dimension: string;
  subjectKind: string;
  subjectId: string;
  subjectLabel: string;
  status: "new" | "recurring" | "resolved" | "regressed";
  firstSeenAt: number;
  lastSeenAt: number;
  lastSeenGroupId: string;
  /** Distinct waves this finding has fired in. */
  occurrenceCount: number;
  resolvedAt: number | null;
  dismissedAt: number | null;
  updatedAt: number;
}

/**
 * One daily trend bucket for the Sessions metric strip sparklines. Mirrors
 * `convex/lib/swarmSessionMetrics.ts` `SwarmSessionMetricsPoint` (hand-kept).
 */
export interface SwarmSessionMetricsPoint {
  dayStartMs: number;
  sessionCount: number;
  toolErrorRate: number | null;
  avgToolCallsPerSession: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  avgTokensPerSession: number | null;
}

/**
 * Aggregated Sessions-tab metrics returned by
 * `journeyRuns:getSwarmSessionMetrics`. Mirrors the backend `SwarmSessionMetrics`
 * (hand-kept, two-repo layout). Every average is null-safe: metrics with no
 * sample come back `null` (rendered as "—"), never a misleading zero.
 */
export interface SwarmSessionMetrics {
  sessionCount: number;
  analyzedCount: number;
  truncated: boolean;
  toolCallCount: number;
  toolErrorCount: number;
  toolErrorRate: number | null;
  sessionsWithToolErrors: number;
  topFailingTool: { toolName: string; errorCount: number } | null;
  avgToolCallsPerSession: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  avgTokensPerSession: number | null;
  tokenSampleCount: number;
  trend: SwarmSessionMetricsPoint[];
}

/**
 * Map a journey session list row into the shape `ShareUsageThreadList` /
 * scenario Sessions cards expect. Swarm sessions are always synthetic for
 * badge purposes even if an older row omitted the flag.
 */
export function journeySessionRowToThread(
  row: JourneySessionRow,
  fallbackPersonaName?: string
): SharedChatThread {
  const displayName =
    row.visitorDisplayName ??
    row.personaLabel ??
    fallbackPersonaName ??
    "Swarm session";
  return {
    _id: row.id,
    sourceType: "swarm",
    chatSessionId: row.chatSessionId,
    visitorDisplayName: displayName,
    modelId: row.modelId,
    messageCount: row.messageCount ?? 0,
    firstMessagePreview: row.firstMessagePreview,
    startedAt: row.startedAt,
    lastActivityAt: row.lastActivityAt ?? row.startedAt,
    synthetic: row.synthetic ?? true,
    personaId: row.personaRefId,
    personaLabel: row.personaLabel ?? fallbackPersonaName,
    readiness: row.readiness as SharedChatThread["readiness"] | undefined,
    // Without this the shared criterion matcher sees a graded swarm session as
    // having no stamp at all and classifies it `ungraded`.
    criteria: row.criteria,
    goalScore: row.goalScore,
  };
}

export type SwarmSessionRunGroup = {
  /** Group key — a `journeyRunId` (by run) or `journeyRefId` (by goal). */
  runId: string | null;
  rows: JourneySessionRow[];
  latestActivityAt: number;
};

function groupSwarmSessionsByKey(
  rows: JourneySessionRow[],
  keyFor: (row: JourneySessionRow) => string | null | undefined
): SwarmSessionRunGroup[] {
  const byKey = new Map<string | null, JourneySessionRow[]>();
  for (const row of rows) {
    const key = keyFor(row) ?? null;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }

  return Array.from(byKey.entries())
    .map(([runId, groupRows]) => {
      const sorted = [...groupRows].sort(
        (a, b) =>
          (b.lastActivityAt ?? b.startedAt) - (a.lastActivityAt ?? a.startedAt)
      );
      return {
        runId,
        rows: sorted,
        latestActivityAt: Math.max(
          ...sorted.map((row) => row.lastActivityAt ?? row.startedAt)
        ),
      };
    })
    .sort((a, b) => b.latestActivityAt - a.latestActivityAt);
}

/** Cluster flat session pages by parent journey run (newest run first). */
export function groupSwarmSessionsByRun(
  rows: JourneySessionRow[]
): SwarmSessionRunGroup[] {
  return groupSwarmSessionsByKey(rows, (row) => row.journeyRunId);
}

/** Cluster flat session pages by goal (`journeyRefId`, newest group first). */
export function groupSwarmSessionsByGoal(
  rows: JourneySessionRow[]
): SwarmSessionRunGroup[] {
  return groupSwarmSessionsByKey(rows, (row) => row.journeyRefId);
}

/**
 * `chatSessionPromote:getChatSessionPromoteDetail` result — the promote
 * dialog's session-servers detail for any promotable sourceType.
 * `usedServerIds` is derived server-side from the stored transcript. The
 * action THROWS on unauthorized access, non-promotable sourceTypes,
 * incomplete swarm run attempts, and unreadable transcripts — adapters
 * surface that as the dialog's detail error.
 */
export interface SwarmSessionPromoteDetail {
  sessionId: string;
  chatSessionId: string;
  sourceType?: string;
  projectId: string | null;
  title: string | null;
  firstMessagePreview: string;
  messageCount: number;
  usedServerIds: string[];
  selectedServers: string[];
  /**
   * The session row's recorded host attribution. Display/compat — prefer
   * `suggestedHostAttachment.namedHostId` when seeding, because on
   * environment-backed scenarios this records the PUBLISH-TIME host while
   * the environment may since have been re-pointed.
   */
  hostId: string | null;
  /**
   * Backend-resolved attachment for the new-suite branch: the host the
   * session actually executes against plus its server set, already
   * environment-aware. Null when the session has no id-shaped selection to
   * donate (transcript-name surfaces), when its host is outside the suite's
   * project, or when the selection is empty. Optional on the wire so the
   * client keeps working against a backend that predates the field.
   */
  suggestedHostAttachment?: {
    namedHostId: string;
    selectedServerIds: string[];
    serverNames: string[];
  } | null;
  /**
   * D8f1. True when promoting this session copies a THIRD PARTY's real words
   * — a real User Testing transcript — into a durable, member-owned artifact.
   * Server-derived; the synthetic carve-out is a policy decision and lives
   * with the policy, not here.
   *
   * Optional on the wire so the dialog keeps working against a backend that
   * predates the field, in which case nothing is asked and nothing is
   * stamped.
   */
  requiresContentTransferAcknowledgement?: boolean;
  /** The policy version an acknowledgement given now is recorded against. */
  contentTransferPolicyVersion?: number;
}

/**
 * `personas:getPersonaTrackRecord` result. The backend rolls the persona's
 * history into aggregate COUNTS + a readiness summary + a few session examples;
 * it does NOT return a succeeded/failed/rateLimited outcome breakdown at the
 * persona level (that lives on the per-journey rollup's `hosts[]`).
 * `readiness` / `sessionExamples` sub-shapes are left permissive on purpose —
 * the contract fixes only the top-level keys.
 */
export interface PersonaTrackRecord {
  personaRefId?: string;
  runCount: number;
  sessionCount: number;
  readiness?: Record<string, unknown>;
  /** Persona-level judge rollup (absent on older backends). */
  goalScore?: GoalScoreRollup;
  sessionExamples?: unknown[];
}

/** One execution TARGET's outcome rollup within {@link JourneyRollup}. Env
 * target rows carry `targetId`; legacy/host rows have none (the backend strips
 * host-shaped target ids so pre-environments rows and fresh host targets group
 * identically). `hostId` is the CURRENT display host. */
export interface JourneyHostRollup {
  hostId: string;
  targetId?: string;
  total: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
  readiness?: Record<string, unknown>;
  /** Per-host judge rollup (absent on older backends). */
  goalScore?: GoalScoreRollup;
}

/**
 * `journeys:getJourneyRollup` result — `{ journeyRefId, runCount, hosts }`.
 * `hosts[]` is the per-host outcome rollup (NOT the old flat `hostSummaries`).
 */
export interface JourneyRollup {
  journeyRefId?: string;
  runCount: number;
  hosts: JourneyHostRollup[];
}

/** Convex pagination envelope. */
export interface Paginated<T> {
  page: T[];
  isDone: boolean;
  continueCursor: string | null;
}

export const DEFAULT_PAGE_SIZE = 10;

// ── REST launch ─────────────────────────────────────────────────────────────

export interface LaunchJourneyRunArgs {
  journeyId: string;
  projectId: string;
  /**
   * One idempotency key per user click, REUSED verbatim if the HTTP call is
   * retried, so a network retry can't spawn a duplicate run. Generate with
   * `crypto.randomUUID()`.
   */
  launchKey: string;
  /**
   * Opaque id shared by every run of ONE co-launched wave, so the Overview can
   * group them without inferring a batch from `createdAt` proximity. A solo
   * "Run again" mints its own and is simply a wave of one. Omitted against a
   * backend that predates the field — those runs stay ungrouped and the panel
   * falls back to time clustering.
   */
  swarmRunGroupId?: string;
  /**
   * Environment fan-out for THIS run, overriding the journey's stored list
   * without rewriting the definition. The create flow uses it so a reused
   * journey runs against the swarm's chosen environments while its own
   * configuration stays exactly as its author left it.
   */
  environmentIds?: string[];
}

export interface LaunchJourneyRunResult {
  runId: string;
}

/**
 * Error thrown by {@link launchJourneyRun} carrying the backend HTTP status so
 * the UI can treat a 4xx (multi-host-cap edge, no hosts, duplicate launch) as
 * an inline, user-actionable message rather than a hard failure.
 */
export class LaunchJourneyRunError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LaunchJourneyRunError";
    this.status = status;
  }
}

/**
 * Launch a journey run through the Inspector REST route. Resolves with the new
 * `runId` on a 202; throws {@link LaunchJourneyRunError} on any non-2xx so the
 * caller can branch on `.status`.
 */
export async function launchJourneyRun(
  args: LaunchJourneyRunArgs
): Promise<LaunchJourneyRunResult> {
  const response = await authFetch(
    `/api/web/swarm/journeys/${encodeURIComponent(args.journeyId)}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: args.projectId,
        launchKey: args.launchKey,
        ...(args.swarmRunGroupId
          ? { swarmRunGroupId: args.swarmRunGroupId }
          : {}),
        ...(args.environmentIds?.length
          ? { environmentIds: args.environmentIds }
          : {}),
      }),
    }
  );

  let body: unknown = undefined;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const rawMessage =
      body && typeof body === "object"
        ? (body as { message?: unknown }).message
        : undefined;
    const message =
      typeof rawMessage === "string" && rawMessage.length > 0
        ? rawMessage
        : `Failed to launch goal run (${response.status})`;
    throw new LaunchJourneyRunError(response.status, message);
  }

  const runId =
    body && typeof body === "object"
      ? (body as { runId?: unknown }).runId
      : undefined;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new LaunchJourneyRunError(
      response.status,
      "Launch accepted but the backend returned no run id"
    );
  }
  return { runId };
}

// ── REST generation ─────────────────────────────────────────────────────────

/**
 * A deterministic check generation suggests for this journey — predicate wire
 * shape, tool name already allowlisted against the grounding snapshot
 * backend-side. Only `toolCalledAtLeastOnce` is ever suggested.
 */
export interface SwarmSuggestedCheck {
  type: "toolCalledAtLeastOnce";
  toolName: string;
}

export interface SwarmGeneratedJourney {
  name?: string;
  goal: string;
  suggestedChecks?: SwarmSuggestedCheck[];
}

export interface SwarmGeneratedPersona {
  name: string;
  role: string;
  notes?: string;
}

/**
 * Error thrown by {@link generateSwarmPersona} / {@link generateSwarmJourneys}
 * carrying the backend HTTP status so the dialog can render a 429 quota
 * message (or a 4xx validation reject) inline instead of a hard failure.
 */
export class SwarmGenerateError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SwarmGenerateError";
    this.status = status;
  }
}

async function postGenerate<T>(
  path: string,
  body: unknown,
  fallbackMessage: string
): Promise<T> {
  const response = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: unknown = undefined;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const body =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    const rawMessage = body?.message;
    const message =
      typeof rawMessage === "string" && rawMessage.length > 0
        ? rawMessage
        : `${fallbackMessage} (${response.status})`;
    const code =
      typeof body?.code === "string"
        ? body.code
        : typeof body?.error === "string"
          ? body.error
          : null;
    const normalized = isNormalizedError(body?.normalized)
      ? (body.normalized as NormalizedError)
      : undefined;
    const details =
      body?.details && typeof body.details === "object"
        ? (body.details as Record<string, unknown>)
        : undefined;
    if (normalized) {
      throw new WebApiError(
        response.status,
        code,
        message,
        normalized,
        details,
      );
    }
    throw new SwarmGenerateError(response.status, message);
  }
  return parsed as T;
}

/**
 * Generate one persona + its journey slate, grounded in a server group's
 * captured tool inventory. Two model calls behind one backend request; the
 * caller creates the actual persona/journey rows via the Convex mutations.
 */
/**
 * Exactly one grounding source (server group XOR environment) — the `never`
 * arms make an accidental both/neither fail to type-check at the call site
 * instead of surfacing as the proxy's 400.
 */
export type SwarmGenerationGrounding =
  | { serverAttachmentId: string; environmentId?: never }
  | { environmentId: string; serverAttachmentId?: never };

export async function generateSwarmPersona(
  args: {
    projectId: string;
    journeyCount: number;
  } & SwarmGenerationGrounding
): Promise<{
  persona: SwarmGeneratedPersona;
  journeys: SwarmGeneratedJourney[];
}> {
  return postGenerate(
    "/api/web/swarm/generate/persona",
    args,
    "Failed to generate persona"
  );
}

/**
 * Generate a SLATE of personas, each with its own journeys, in one request.
 *
 * The batch sibling of {@link generateSwarmPersona} — same endpoint, and
 * `personaCount` is what selects this response shape (its absence keeps the
 * single-persona one). The backend drops any persona whose journey slate
 * failed rather than failing the whole request, so a short slate is a normal
 * partial success; callers should render what came back, not assume
 * `personaCount` entries.
 *
 * `description` is the user's own words about their audience and
 * `existingPersonas` are dedup hints — both optional, both only ever reach the
 * generation prompts.
 */
export async function generateSwarmPersonaBatch(
  args: {
    projectId: string;
    personaCount: number;
    journeyCount: number;
    description?: string;
    existingPersonas?: { name: string; role: string }[];
  } & SwarmGenerationGrounding
): Promise<{
  personas: {
    persona: SwarmGeneratedPersona;
    journeys: SwarmGeneratedJourney[];
  }[];
}> {
  return postGenerate(
    "/api/web/swarm/generate/persona",
    args,
    "Failed to generate personas"
  );
}

/** Generate a journey slate for an existing persona (fields passed inline). */
export async function generateSwarmJourneys(
  args: {
    projectId: string;
    journeyCount: number;
    persona: SwarmGeneratedPersona;
  } & SwarmGenerationGrounding
): Promise<{ journeys: SwarmGeneratedJourney[] }> {
  return postGenerate(
    "/api/web/swarm/generate/journeys",
    args,
    "Failed to generate goals"
  );
}

/**
 * Subscribe to the multiplexed SSE stream for a journey run. Events are
 * scoped by `chatSessionId` / `hostId` / `sessionIndex`. Resolves when the
 * stream ends (`run_complete` or disconnect).
 */
export async function streamJourneyRun(
  runId: string,
  onEvent: (event: SwarmStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await authFetch(
    `/api/web/swarm/runs/${encodeURIComponent(runId)}/stream`,
    {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal,
    }
  );

  if (!response.ok) {
    let message = `Failed to stream goal run (${response.status})`;
    try {
      const body = (await response.json()) as {
        message?: string;
        error?: string;
      };
      if (typeof body.message === "string" && body.message.length > 0) {
        message = body.message;
      } else if (typeof body.error === "string" && body.error.length > 0) {
        message = body.error;
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body for swarm run stream");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const emitSseLine = (line: string) => {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("data: ")) return;
    const data = trimmedLine.slice(6).trim();
    if (!data || data === "[DONE]") return;
    try {
      onEvent(JSON.parse(data) as SwarmStreamEvent);
    } catch {
      // ignore malformed lines
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        emitSseLine(line);
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split("\n")) {
      emitSseLine(line);
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // ignore
    }
  }
}

/**
 * Deterministic attempt chatSessionId — the SHARED mint (D1), re-exported so
 * the client mirror can never drift from the runner's claim key. Legacy host
 * targets pass `{ hostId }` (byte-identical to the historical form); env
 * targets pass `{ hostId, environmentId }` from `environmentRef.environmentId`.
 */
export {
  swarmAttemptChatSessionId,
  type SwarmSessionTargetIdentity,
} from "@/shared/swarm-session-id";
