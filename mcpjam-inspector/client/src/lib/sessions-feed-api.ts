/**
 * Unified sessions layer client contract — the ONE place the Sessions surface
 * reaches the backend.
 *
 * Centralizes the project-scoped Convex query NAMES the UI subscribes to
 * (Convex codegen doesn't run in the inspector, so these are string-keyed
 * `as any` reads — keeping the names here stops them scattering through the
 * component) and the response DTOs those reads return. Mirrors the backend
 * `convex/sessionsFeed.ts` by hand (two-repo layout) — the field list here IS
 * the contract, and the panel's tests type their fixtures against it so a
 * backend rename forces an edit rather than silently rendering blanks.
 */
// Type-only imports — one declaration of each backend contract, not two.
import type { SessionCriteria, SessionGoalScore } from "@/lib/swarm-api";
import type { SessionReadiness } from "@/components/scenarios/session-readiness";

// ── Convex query names (string-keyed reads) ─────────────────────────────────
export const SESSIONS_FEED_QUERIES = {
  /**
   * The project's cross-surface session feed, newest first. Paginated;
   * `sourceTypes` / `status` are SERVER-side filters (they select the index),
   * unlike the client-side-over-loaded-pages convention elsewhere — the
   * backend built indexes for exactly these.
   */
  listProjectSessions: "sessionsFeed:listProjectSessions",
  /**
   * Relevance-ordered title search over the same scope + authorization.
   * A separate query, not a `q` arg on the feed: search results cannot be
   * re-sorted to recency, so mixing them would change the feed's ordering
   * contract mid-subscription.
   */
  searchProjectSessions: "sessionsFeed:searchProjectSessions",
} as const;

// ── DTOs ────────────────────────────────────────────────────────────────────

export type SessionFeedSourceType = "direct" | "scenario" | "eval" | "swarm";

/**
 * A session's parent run — a DISCRIMINATED UNION on `kind`. The backend may
 * add kinds; treat an unknown `kind` as "no chip", never as an error.
 * `label: null` means the parent row is gone (deleted suite / journey /
 * scenario) — the ids remain so the reference can still be named.
 */
export type SessionFeedParentRef =
  | {
      kind: "evalRun";
      iterationId: string;
      /** `null` = Quick Run (no suite run exists, by construction). */
      suiteRunId: string | null;
      suiteId: string | null;
      label: string | null;
    }
  | {
      kind: "journeyRun";
      journeyRunId: string;
      journeyRefId: string | null;
      label: string | null;
    }
  | {
      kind: "scenario";
      scenarioId: string;
      label: string | null;
    };

/**
 * One feed row — the backend `SessionFeedItemDto`. The row identifier is `id`
 * (`chatSessions._id` under the hood): it is what `ShareUsageThreadDetail`
 * opens. Fields the backend may not yet write are optional so an older
 * deployment still renders.
 *
 * Counter absence is meaningful: `cumulativeInputTokens === undefined` means
 * "no turn ever reported usage", which is a different claim from 0 — never
 * default it.
 */
export interface SessionFeedItem {
  /** `chatSessions._id` — the detail-pane / deep-link id. */
  id: string;
  chatSessionId: string;
  projectId: string | null;
  sourceType: SessionFeedSourceType;
  origin?: string | null;
  status: "active" | "archived";
  synthetic?: boolean;
  lockReason?: string | null;
  /** Resolved title chain (customTitle → displayLabel → persona/visitor → preview). */
  title: string | null;
  firstMessagePreview: string;
  /** Direct rows only: `"private" | "project"`. `null` for every other bucket. */
  visibility: "private" | "project" | null;
  ownedByViewer: boolean;
  startedAt: number;
  lastActivityAt: number;
  modelId?: string | null;
  messageCount: number;
  cumulativeUserMessageCount?: number;
  cumulativeToolCallCount?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  readiness?: SessionReadiness | null;
  goalScore?: SessionGoalScore;
  criteria?: SessionCriteria;
  parentRef: SessionFeedParentRef | null;
}

/** Product name per persistence bucket, as rendered on the row badge. */
export const SESSION_SOURCE_TYPE_LABELS: Record<SessionFeedSourceType, string> =
  {
    direct: "Playground",
    scenario: "User Testing",
    eval: "Eval",
    swarm: "Swarm",
  };

/** Product-surface labels. Unknown origins render as the raw string (spike 6). */
export const SESSION_ORIGIN_LABELS: Record<string, string> = {
  playground: "Playground",
  mcpjam_agent: "Agent",
  scenario: "User Testing",
  eval: "Eval",
  swarm: "Swarm",
  api: "API",
};

export function sessionOriginChipLabel(
  origin: string | null | undefined
): string | null {
  if (!origin) return null;
  // Own-key only: "constructor" / "toString" / "__proto__" are inherited
  // and must render as the raw origin, not a Function or Object.
  return Object.hasOwn(SESSION_ORIGIN_LABELS, origin)
    ? SESSION_ORIGIN_LABELS[origin]
    : origin;
}

/**
 * The parent chip for a row. Falls back to naming the run kind when the
 * parent's own label is gone, and calls out Quick Runs (which genuinely have
 * no suite run) instead of leaving them unexplained.
 */
export function sessionParentChipLabel(
  ref: SessionFeedParentRef | null
): string | null {
  if (!ref) return null;
  if (ref.label) return ref.label;
  switch (ref.kind) {
    case "evalRun":
      return ref.suiteRunId === null ? "Quick Run" : "Eval run";
    case "journeyRun":
      return "Swarm run";
    case "scenario":
      return "Scenario";
    default:
      // Future parent kinds render nothing rather than a wrong guess.
      return null;
  }
}

export const SESSIONS_FEED_PAGE_SIZE = 25;
