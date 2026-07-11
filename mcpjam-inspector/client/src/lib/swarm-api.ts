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

// ── Convex query names (string-keyed reads) ─────────────────────────────────
export const SWARM_QUERIES = {
  listPersonas: "personas:listPersonas",
  personaTrackRecord: "personas:getPersonaTrackRecord",
  listJourneysByPersona: "journeys:listJourneysByPersona",
  journeyRollup: "journeys:getJourneyRollup",
  listHosts: "hosts:listHosts",
  listJourneyRuns: "journeyRuns:listJourneyRuns",
  listSessionsByJourneyRun: "journeyRuns:listSessionsByJourneyRun",
  listSessionsByHost: "journeyRuns:listSessionsByHost",
  listSessionsByJourney: "journeyRuns:listSessionsByJourney",
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

export interface JourneyRun {
  _id: string;
  status: JourneyRunStatus | string;
  summary: JourneyRunSummary;
  hostSummaries: JourneyHostSummary[];
  createdAt: number;
}

/**
 * A single synthetic session row for the sessions-by-host view. Shape mirrors
 * the backend `listSessionsBy*` page items; fields the readiness/diagnostics
 * strip needs are optional so the UI degrades gracefully when the backend
 * hasn't denormalized them yet.
 */
export interface JourneySessionRow {
  /** sharedChatThreads doc id — the id `ShareUsageThreadDetail` opens. */
  _id: string;
  chatSessionId: string;
  hostId: string;
  personaId?: string;
  personaLabel?: string;
  status?: string;
  modelId?: string;
  startedAt: number;
  lastActivityAt?: number;
  messageCount?: number;
  /** Server-denormalized readiness subset (see `session-readiness.tsx`). */
  readiness?: {
    status?: string;
    verdict?: string;
    issueCount?: number;
  };
}

export interface PersonaTrackRecord {
  personaId?: string;
  totalRuns: number;
  totalSessions: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
  /** Optional per-host breakdown the backend may include. */
  hostBreakdown?: JourneyHostSummary[];
}

export interface JourneyRollup {
  journeyRefId?: string;
  totalRuns: number;
  hostSummaries: JourneyHostSummary[];
  lastRunAt?: number;
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
