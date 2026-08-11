/**
 * User Testing insights client contract — the ONE place this surface names the
 * window-insights backend.
 *
 * Convex codegen doesn't run in the inspector, so every read is a string-keyed
 * `as any`. Keeping the names here rather than inline is what stops a rename
 * on the backend from having to be chased through components — and what makes
 * "which queries does this surface depend on" answerable by reading one file.
 * Mirrors `lib/swarm-api.ts`, whose swarm twin these DTOs deliberately echo.
 *
 * DTOs are hand-mirrored from `convex/chatboxWindowInsights.ts` and
 * `convex/lib/chatboxWindowInsightsValidators.ts` (two-repo norm).
 */

// ── Convex query names (string-keyed reads) ─────────────────────────────────
export const CHATBOX_INSIGHTS_QUERIES = {
  /**
   * Live deterministic signals for the current 7-day window, plus the latest
   * snapshot's group id and the freshness watermarks. Cheap by construction
   * (session-row denormalizations only, no transcript reads), so it is safe as
   * a live subscription. Guest-readable.
   */
  getWindowSignals: "chatboxWindowInsights:getWindowSignals",
  /** Lane A narration for one frozen window (null ⇒ never requested). */
  getWindowInsights: "chatboxWindowInsights:getWindowInsights",
  /** The chatbox's durable findings registry, joined to signals by fingerprint. */
  listChatboxFindings: "chatboxWindowInsights:listChatboxFindings",
} as const;

// ── Convex mutation names (string-keyed writes) ─────────────────────────────
export const CHATBOX_INSIGHTS_MUTATIONS = {
  /**
   * Kick off Lane A generation for the latest analyzed window (`force` to
   * regenerate). MEMBER-ONLY — it spends. Throws `window_not_analyzed` when
   * the scenario has never been analyzed, which is the client's cue to offer
   * "Analyze now" instead.
   */
  requestWindowInsights: "chatboxWindowInsights:requestWindowInsights",
  cancelWindowInsights: "chatboxWindowInsights:cancelWindowInsights",
} as const;

// Dismissal is NOT listed here. `swarmWaveInsights:dismissFinding` is
// scope-branched server-side — the finding row's own scope decides whether it
// authorizes by project role or by the chatbox's workspace role — so it is one
// mutation, named once, from `lib/swarm-api.ts` where it lives. A second name
// for it here would read as a second function.

// ── DTOs ────────────────────────────────────────────────────────────────────

/**
 * Detector ids the chatbox miner emits. Three have no swarm equivalent —
 * there is no feedback, no terminal-error facet, and no visitor cohort in a
 * swarm wave — and four are shared with it.
 */
export type ChatboxDetectorId =
  | "tool_errors"
  | "hallucinated_tool"
  | "negative_feedback"
  | "terminal_error_concentration"
  | "cohort_struggles"
  | "token_outlier"
  | "latency_outlier";

export interface ChatboxWindowSignalCandidate {
  detector: ChatboxDetectorId | string;
  subjectKind: "tool" | "path" | "model" | "cohort" | "surface" | string;
  /**
   * Identity component the fingerprint is built from. NOT displayable: path
   * subjects are `ph_<16hex>` hashes of the route key. Render `subjectLabel`.
   */
  subjectId: string;
  subjectLabel: string;
  affectedSessions: number;
  sliceTotal: number;
  metric?: number;
  /** Same magnitude over the rest of the window (relative detectors). */
  waveMetric?: number;
  exemplarSessionIds: string[];
  contrastSessionIds: string[];
  severityScore: number;
}

/** Result of `getWindowSignals` (null ⇒ unknown chatbox / not authorized). */
export interface ChatboxWindowSignals {
  candidates: ChatboxWindowSignalCandidate[];
  sessionCount: number;
  /** Sessions with no usable readiness record (pending/failed/absent). */
  unanalyzedSessionCount: number;
  /** Deduped rated sessions in the window. */
  feedbackCount: number;
  windowStartAt: number;
  windowEndAt: number;
  /** The window scan hit its cap; counts cover a subset. */
  truncated: boolean;
  feedbackTruncated: boolean;
  /** Most sessions unanalyzed — treat every count as partial. */
  lowConfidence: boolean;
  /**
   * The latest frozen snapshot's group id — the key the insights lifecycle and
   * the findings join are addressed by. Null before the first analysis.
   */
  latestGroupId: string | null;
  latestSnapshotAt: number | null;
  /**
   * Live traffic has moved past the analyzed data (a session or a rating
   * landed after the newest snapshot's watermarks). NOT the same thing as
   * `latestRun.isStale`, which means an in-flight job blew its lease.
   */
  dataStale: boolean;
}

export interface ChatboxWindowInsightCandidate {
  /** `<detector>:<subjectKind>:<subjectId>` — joins to a registry finding. */
  fingerprint: string;
  detector: ChatboxDetectorId | string;
  subjectKind: string;
  subjectId: string;
  subjectLabel: string;
  affectedSessions: number;
  sliceTotal: number;
  metric?: number;
  waveMetric?: number;
  evidenceSessionIds: string[];
  contrastSessionIds: string[];
  evidenceTruncated: boolean;
  findingStatus?: string;
  rootCause: string;
  recommendation: string;
  confidence: "low" | "medium" | "high";
}

export interface ChatboxWindowInsights {
  summary: string;
  generatedAt: number;
  modelUsed: string;
  providerKey: string;
  /** The previous window this one was compared against, when one existed. */
  baselineWindowGroupId?: string;
  sessionCount: number;
  unanalyzedSessionCount: number;
  /** Direct user voice in the window — this surface's honesty qualifier,
   * where a swarm wave reports judge coverage. */
  feedbackCount: number;
  truncated: boolean;
  /** The feedback scan hit its cap — `feedbackCount` is a floor, not a total. */
  feedbackTruncated?: boolean;
  lowConfidence: boolean;
  candidates: ChatboxWindowInsightCandidate[];
  unnarratedCandidates: Array<{
    fingerprint: string;
    detector: string;
    subjectLabel: string;
    affectedSessions: number;
    sliceTotal: number;
  }>;
}

/** Lifecycle envelope returned by `getWindowInsights`. */
export interface ChatboxWindowInsightsDto {
  windowGroupId: string;
  status: "pending" | "completed" | "failed";
  insights: ChatboxWindowInsights | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: number;
}

/** A durable finding in the chatbox registry (Sentry model). */
export interface ChatboxFinding {
  _id: string;
  fingerprint: string;
  detector: string;
  subjectKind: string;
  subjectId: string;
  subjectLabel: string;
  status: "new" | "recurring" | "resolved" | "regressed";
  firstSeenAt: number;
  lastSeenAt: number;
  occurrenceCount: number;
  resolvedAt: number | null;
  dismissedAt: number | null;
}
