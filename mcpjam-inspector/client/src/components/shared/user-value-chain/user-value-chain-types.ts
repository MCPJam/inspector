/**
 * Client-side shapes for the stored chat-session user-value chain.
 *
 * A structural mirror of `convex/lib/chatSessionStageDerivation.ts` and
 * `convex/lib/chatSessionStageAggregate.ts`, kept here for the reason every
 * other Convex-backed panel in this tree keeps one: the client cannot import
 * the backend's validators, and a `useQuery` result typed `any` is how a
 * renderer starts inventing fields the backend never had.
 *
 * NOTHING HERE DERIVES. Every value below is read off the wire exactly as the
 * backend stored it. React does not decide a stage, does not decide staleness,
 * and does not compute a rate — the two helpers in this file only pick which
 * of the backend's own answers to show. The moment a component starts folding
 * rows itself, there are two definitions of the chain and one of them is
 * wrong.
 */

import type {
  FailureCategory,
  StageReason,
  StageState,
  UserValueStage,
} from "@mcpjam/sdk/contract";

export type ChatSessionStageSource = "user_testing" | "swarm" | "direct";

export type StageResultRow = {
  stage: UserValueStage;
  state: StageState;
  reason?: StageReason;
  evidence?: {
    spanIds?: string[];
    promptIndexes?: number[];
    predicateReasons?: string[];
  };
};

export type ChatSessionStageStatus =
  | "pending"
  | "deriving"
  | "completed"
  | "failed";

export type ChatSessionStageDerivation = {
  status: ChatSessionStageStatus;
  generation: number;
  source: ChatSessionStageSource;
  requestedAt: number;
  attempts: number;
  stageResults?: StageResultRow[];
  firstFailedStage?: UserValueStage;
  failureCategory?: FailureCategory;
  stageAnalyzerVersion?: number;
  derivedAt?: number;
  analyzerVersionAhead?: boolean;
  errorCode?: string;
};

export type StageTally = {
  stage: UserValueStage;
  passed: number;
  failed: number;
  /** `passed + failed`. The ONLY denominator `passRate` is over. */
  eligible: number;
  notMeasured: number;
  notApplicable: number;
  notReached: number;
  observations: number;
  /** `null` when nothing was eligible. Render the word, never a bar at zero. */
  passRate: number | null;
};

export type ChatSessionStageFunnel = {
  source: ChatSessionStageSource | null;
  total: number;
  counted: number;
  exclusions: {
    absent: number;
    deriving: number;
    stale: number;
    failed: number;
  };
  stages: StageTally[];
  firstFailedStage: Partial<Record<UserValueStage, number>>;
  notMeasured: boolean;
  truncated: boolean;
};

/**
 * What a reader is looking at right now.
 *
 * Four states, and none of them collapses into another:
 *
 *   - `absent`   — no chain was ever derived for this session. Unmeasured,
 *                  and honestly so: everything before D8, plus anything no
 *                  producer has touched.
 *   - `deriving` — a generation is owed or in flight and there is nothing
 *                  older to show.
 *   - `stale`    — there ARE rows, and the evidence has moved under them. The
 *                  rows are still shown, labelled, because a reader between
 *                  generations is better served by "here is last week's
 *                  answer, a new one is coming" than by a blank panel.
 *   - `current`  — the rows describe the session's current evidence.
 *
 * Read off the backend's own `status`; nothing here re-decides it.
 */
export type ChainPresentation = "absent" | "deriving" | "stale" | "current";

export function chainPresentation(
  derivation: ChatSessionStageDerivation | null | undefined
): ChainPresentation {
  if (!derivation) return "absent";
  if (derivation.status === "completed" && derivation.stageResults) {
    return "current";
  }
  // Rows from an earlier generation, kept on the row on purpose by
  // `markStagePending` so a re-grade does not blank a working panel.
  if (derivation.stageResults) return "stale";
  if (derivation.status === "failed") return "absent";
  return "deriving";
}

/** `72%`, or `null` when there is no rate to render. */
export function formatPassRate(rate: number | null): string | null {
  return rate === null ? null : `${Math.round(rate * 100)}%`;
}
