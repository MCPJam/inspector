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
  listSessionsByJourneyRun: "journeyRuns:listSessionsByJourneyRun",
  /** Flat Sessions-tab default: all swarm sessions in the project. */
  listSessionsByProject: "journeyRuns:listSessionsByProject",
  /** Sessions-tab persona filter (narrows the project feed). */
  listSessionsByPersona: "journeyRuns:listSessionsByPersona",
  /** Sessions-tab metric strip aggregates (project-wide or persona-scoped). */
  getSwarmSessionMetrics: "journeyRuns:getSwarmSessionMetrics",
  listRunningPersonaRefIds: "journeyRuns:listRunningPersonaRefIds",
} as const;

// ── Convex action names (string-keyed calls) ────────────────────────────────
export const SWARM_ACTIONS = {
  /** Source-agnostic promote-dialog detail read (`convex/chatSessionPromote.ts`). */
  getChatSessionPromoteDetail: "chatSessionPromote:getChatSessionPromoteDetail",
} as const;

// ── DTOs ────────────────────────────────────────────────────────────────────

/** Terminal + in-flight states a journey run can surface in the UI. */
export type JourneyRunStatus =
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "rate_limited"
  | "stale";

export interface JourneyRunSummary {
  total: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
}

export interface JourneyHostSummary {
  hostId: string;
  total: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
}

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

export interface JourneyRun {
  _id: string;
  status: JourneyRunStatus | string;
  summary: JourneyRunSummary;
  hostSummaries: JourneyHostSummary[];
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
 * chatbox Sessions cards expect. Swarm sessions are always synthetic for
 * badge purposes even if an older row omitted the flag.
 */
export function journeySessionRowToThread(
  row: JourneySessionRow,
  fallbackPersonaName?: string,
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
    goalScore: row.goalScore,
  };
}

/**
 * `chatSessionPromote:getChatSessionPromoteDetail` result — the promote
 * dialog's session-servers detail for any promotable sourceType.
 * `usedServerIds` is derived server-side from the stored transcript;
 * `hostId` is the session row's authoritative host attribution (used to
 * pre-seed the new-suite client attachment). The action THROWS on
 * unauthorized access, non-promotable sourceTypes, incomplete swarm run
 * attempts, and unreadable transcripts — adapters surface that as the
 * dialog's detail error.
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
  hostId: string | null;
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

/** One host's outcome rollup within {@link JourneyRollup}. */
export interface JourneyHostRollup {
  hostId: string;
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
  args: LaunchJourneyRunArgs,
): Promise<LaunchJourneyRunResult> {
  const response = await authFetch(
    `/api/web/swarm/journeys/${encodeURIComponent(args.journeyId)}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: args.projectId,
        launchKey: args.launchKey,
      }),
    },
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
        : `Failed to launch journey run (${response.status})`;
    throw new LaunchJourneyRunError(response.status, message);
  }

  const runId =
    body && typeof body === "object"
      ? (body as { runId?: unknown }).runId
      : undefined;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new LaunchJourneyRunError(
      response.status,
      "Launch accepted but the backend returned no run id",
    );
  }
  return { runId };
}

/**
 * Subscribe to the multiplexed SSE stream for a journey run. Events are
 * scoped by `chatSessionId` / `hostId` / `sessionIndex`. Resolves when the
 * stream ends (`run_complete` or disconnect).
 */
export async function streamJourneyRun(
  runId: string,
  onEvent: (event: SwarmStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await authFetch(
    `/api/web/swarm/runs/${encodeURIComponent(runId)}/stream`,
    {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal,
    },
  );

  if (!response.ok) {
    let message = `Failed to stream journey run (${response.status})`;
    try {
      const body = (await response.json()) as { message?: string; error?: string };
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

/** Deterministic attempt chatSessionId — matches the swarm runner claim key. */
export function swarmAttemptChatSessionId(
  runId: string,
  hostId: string,
  sessionIndex: number,
): string {
  return `synth_${runId}_${hostId}_${sessionIndex}`;
}
