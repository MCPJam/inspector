import { useQuery } from "convex/react";
import type {
  EvalTraceBrowserInteractionStepView,
  EvalTraceWidgetRenderObservationView,
} from "@/shared/eval-trace";
import type { SessionReadiness } from "@/components/scenarios/session-readiness";
import type { ChatSessionStageDerivation } from "@/components/shared/user-value-chain/user-value-chain-types";
// Type-only import, so the SharedChatThread import on the other side is not a
// runtime cycle. One declaration of the backend contract, not two.
import type { SessionCriteria } from "@/lib/swarm-api";
import type { SessionSentiment } from "@/hooks/scenario-usage-filters";

export type SharedChatSourceType = "scenario" | "swarm";

export interface SharedChatThread {
  _id: string;
  sourceType: SharedChatSourceType;
  surface?: "preview" | "share_link";
  shareId?: string;
  scenarioId?: string;
  chatSessionId: string;
  serverId?: string;
  userId?: string;
  visitorDisplayName?: string;
  modelId?: string;
  messageCount: number;
  firstMessagePreview?: string;
  startedAt: number;
  lastActivityAt: number;
  messagesBlobUrl?: string;
  /**
   * Flat projections of the session's per-turn ratings, carrying the
   * WORST-TURN policy: `feedbackRating` is the minimum rating across the
   * session's turns and `feedbackComment` is that turn's comment. The backend
   * maps them from `chatSessions.feedback.{min, worstComment}`; they stay flat
   * because every filter and sort in `scenario-usage-filters.ts` reads them.
   */
  feedbackRating?: number | null;
  feedbackComment?: string | null;
  feedbackCount?: number;
  /**
   * The full rollup, for DISPLAY (average across N ratings). Absent on rows
   * from an older backend, which is why the flat fields above stay the filter
   * surface rather than being replaced by this.
   */
  feedback?: {
    count: number;
    avg: number;
    min: number;
    hasComment: boolean;
    worstComment?: string;
    latestRating: number;
    latestAt: number;
    /**
     * Thumb tallies, when the session was rated with the thumbs widget. Both
     * are absent on star-only sessions AND on any summary written before
     * thumbs existed, and the backend emits each only when non-zero — so
     * `count - up - down` is how many star rows the session has, and a
     * non-zero remainder is what makes a session "mixed".
     */
    thumbUpCount?: number;
    thumbDownCount?: number;
  } | null;
  toolCallCount?: number;
  /** OAuth or permission flow interrupted the session. */
  authInterrupted?: boolean;
  // Sandbox usage-insights fields (populated only for sandbox sessions).
  themeClusterId?: string;
  themeClusterLabel?: string;
  themeKeywords?: string[];
  deviceKind?: "desktop" | "mobile" | "tablet" | "bot";
  userAgentFamily?: string;
  authType?: "signedIn" | "guest";
  visitorRecency?: "new" | "returning";
  visitorSegment?: string;
  language?: string;
  /**
   * Goal facets, written by the cluster rebuild. All optional and all absent on
   * sessions that predate the goal/outcome split — absence means "not
   * analyzed", which is a different claim from the `unclear` outcome, so the UI
   * must not substitute a default for a missing field.
   */
  outcome?: "completed" | "partial" | "unresolved" | "errored" | "unclear";
  outcomeConfidence?: number;
  friction?: string;
  /**
   * Model-inferred user sentiment. Absent until a run at signals version 2+.
   * Derived from the shared contract rather than restated, so a change to the
   * closed list cannot leave thread data and the filters disagreeing.
   */
  sentiment?: SessionSentiment;
  /** Deterministic evidence, recorded beside the outcome and never folded in. */
  terminalToolError?: boolean;
  /**
   * Emergent theme per signal axis. `themeClusterId` above is the goal one,
   * kept under its original name so existing readers keep working.
   */
  behaviorClusterId?: string;
  behaviorClusterLabel?: string;
  outcomeClusterId?: string;
  outcomeClusterLabel?: string;
  sentimentClusterId?: string;
  sentimentClusterLabel?: string;
  /** Multi-label trajectory tags, derived from the transcript (no model call). */
  behaviorTags?: string[];
  /** Collapsed tool route, e.g. `search→get`. `no_tools` when none ran. */
  pathKey?: string;
  /**
   * The hostConfigId that was active on the scenario's referenced host
   * when this session opened. Pinned at session-insert time; survives
   * host edits forward so the UI can show "this session ran against
   * config rev #N". Use `useSessionHistoricalHostConfig` to resolve it
   * to model / server / etc.
   */
  hostConfigIdAtStart?: string;
  /**
   * Replay configuration recorded on the session. For a SYNTHETIC (swarm)
   * session, BE-5 derives the plugin fields SERVER-SIDE from the journey run's
   * immutable target snapshot — never from anything the runner sends — so they
   * are provenance about the run, not a claim the caller could make.
   *
   * Only the plugin fields are declared: `getSession` spreads the whole
   * session document, and re-mirroring the rest of the resume config here
   * would create a second, drifting copy of a contract that already has one.
   *
   * `pluginServerIds` is a SIBLING of the ordinary server selection, never
   * merged into it, for the same reason it is on the journey snapshot: a
   * plugin-materialized id inside a resumable selection would outlive the
   * plugin's own lifecycle controls. Anything that resumes must re-gate them
   * (decision D2) rather than reconnecting on the strength of this record.
   */
  resumeConfig?: {
    pluginVersions?: Array<{
      pluginId: string;
      pluginVersionId: string;
      name: string;
      bundleHash: string;
    }>;
    pluginServerIds?: string[];
  };
  /** AI-generated scenario session. Drives the "Synthetic" badge + filter. */
  synthetic?: boolean;
  personaId?: string;
  personaLabel?: string;
  synthesisRunId?: string;
  /**
   * Phase 1 deterministic readiness. The list query (`listByScenario`) returns
   * the compact `status`/`verdict`/`issueCount` signal; the detail query
   * (`getSession`) returns the full record with denormalized findings.
   */
  readiness?: SessionReadiness;
  /**
   * Compact deterministic rubric verdict (mirrors `chatSessions.criteria`).
   * Absent on scenario threads and on swarm threads whose run carried no
   * rubric — those render no criterion chip rather than a misleading 0/0.
   */
  criteria?: SessionCriteria;
  /**
   * Goal-completion judge verdict for SWARM sessions — the compact
   * denormalized `chatSessions.goalScore` subset (see backend
   * `convex/swarmJudge.ts`). Absent on non-swarm sessions and before the
   * first grading; `getSession` spreads the whole doc so this flows through.
   */
  goalScore?: {
    status?: string;
    score?: number;
    passed?: boolean;
    threshold?: number;
    reason?: string;
    error?: string;
  };
  /**
   * The session's derived user-value chain (`chatSessions.stageDerivation`).
   *
   * Absent on every session written before D8 and on any the analyzer has not
   * been asked about; that absence is UNMEASURED and the chain panel renders
   * it as such. `getSession` spreads the whole doc, so this flows through
   * without a query change.
   */
  stageDerivation?: ChatSessionStageDerivation;
}

/**
 * The pinned historical hostConfig a session was opened against — the
 * shape the chip / "view config" deep-link reads from. Backend resolves
 * `chatSessions.hostConfigIdAtStart` through the (append-only)
 * hostConfigs table, so even after the host has rotated forward the
 * row this points at is still readable.
 */
export interface SessionHistoricalHostConfig {
  hostConfigId: string;
  hostStyle: string;
  modelId: string;
  systemPrompt: string;
  temperature: number;
  requireToolApproval: boolean;
  serverIds: string[];
  optionalServerIds: string[];
  serverCount: number;
  /** Name of the host the scenario *currently* references, if any. */
  currentHostName: string | null;
}

export function useSessionHistoricalHostConfig({
  sessionId,
}: {
  sessionId: string | null;
}) {
  const config = useQuery(
    "chatSessions:getSessionHistoricalHostConfig" as any,
    sessionId ? ({ sessionId } as any) : "skip"
  ) as SessionHistoricalHostConfig | null | undefined;

  return { config };
}

export interface SharedChatWidgetSnapshot {
  _id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  serverId: string;
  uiType: "mcp-apps" | "openai-apps";
  resourceUri?: string;
  widgetCsp: Record<string, unknown> | null;
  widgetPermissions: Record<string, unknown> | null;
  widgetPermissive: boolean;
  prefersBorder: boolean;
  widgetHtmlUrl?: string | null;
}

export function useSharedChatThreadList({
  sourceId,
}: {
  sourceType?: SharedChatSourceType;
  sourceId: string | null;
}) {
  const queryArgs = sourceId
    ? ({ scenarioId: sourceId, limit: 50, includeInternal: true } as any)
    : "skip";

  const threads = useQuery("chatSessions:listByScenario" as any, queryArgs) as
    | SharedChatThread[]
    | undefined;

  return { threads };
}

export function useSharedChatThread({ threadId }: { threadId: string | null }) {
  const thread = useQuery(
    "chatSessions:getSession" as any,
    threadId ? ({ sessionId: threadId } as any) : "skip"
  ) as SharedChatThread | null | undefined;

  return { thread };
}

export function useSharedChatWidgetSnapshots({
  threadId,
}: {
  threadId: string | null;
}) {
  const snapshots = useQuery(
    "chatSessions:getWidgetSnapshots" as any,
    threadId ? ({ sessionId: threadId } as any) : "skip"
  ) as SharedChatWidgetSnapshot[] | undefined;

  return { snapshots };
}

export interface SharedChatTurnTrace {
  turnId: string;
  promptIndex: number;
  startedAt: number;
  endedAt: number;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  spanCount: number;
  modelId?: string;
  spansBlobUrl?: string | null;
}

export function useSharedChatTurnTraces({
  threadId,
}: {
  threadId: string | null;
}) {
  const traces = useQuery(
    "chatSessions:getSessionTurnTraces" as any,
    threadId ? ({ sessionId: threadId } as any) : "skip"
  ) as SharedChatTurnTrace[] | undefined;

  return { traces };
}

export interface SharedChatTurnScore {
  key: string;
  turnId?: string;
  promptIndex?: number;
  dataType: "numeric" | "categorical" | "boolean";
  value?: number;
  stringValue?: string;
  comment?: string;
  source: "end_user" | "member" | "eval";
  createdAt: number;
  updatedAt: number;
}

/**
 * Every score on a session, for the PM-facing detail view — the per-turn stars
 * a tester left, joined to the transcript by `promptIndex`.
 *
 * Returned in prompt order by the backend, so a caller can zip it against the
 * adapted messages without re-sorting.
 */
export function useSharedChatTurnScores({
  threadId,
}: {
  threadId: string | null;
}) {
  const scores = useQuery(
    "sessionScores:listBySession" as any,
    threadId ? ({ sessionId: threadId } as any) : "skip"
  ) as SharedChatTurnScore[] | undefined;

  return { scores };
}

export interface SessionBrowserArtifacts {
  widgetRenderObservations: EvalTraceWidgetRenderObservationView[];
  browserInteractionSteps: EvalTraceBrowserInteractionStepView[];
  /**
   * Session-scoped replay `.webm`, resolved server-side. Present (as `null`) on
   * the artifact-less shape too, so a replay surface branches on data rather
   * than on `undefined`.
   */
  videoUrl: string | null;
}

/**
 * Browser-rendered MCP App artifacts for a session — render observations,
 * Computer Use steps, and the replay video — written by the synthetic-session
 * runner. Sorted and url-resolved server-side; empty arrays / null video for
 * sessions without browser artifacts (live visitor sessions, pre-feature runs).
 */
export function useSessionBrowserArtifacts({
  threadId,
}: {
  threadId: string | null;
}) {
  const artifacts = useQuery(
    "chatSessions:getBrowserArtifacts" as any,
    threadId ? ({ sessionId: threadId } as any) : "skip"
  ) as SessionBrowserArtifacts | undefined;

  return { artifacts };
}
