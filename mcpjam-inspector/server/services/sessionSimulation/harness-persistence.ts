import type { PersistChatOutcome } from "../../utils/chat-ingestion.js";
import {
  releaseUncommittedHarnessLane,
  type HarnessSessionCommitPayload,
} from "../../utils/harness/harness-session-state.js";
import { logger } from "../../utils/logger.js";

/**
 * A turn persist that threw instead of returning an outcome.
 *
 * For a harness turn it becomes a failed outcome, so the lane release in
 * `requirePersistedHarnessTurn` still runs; leaving the throw would skip it and
 * hold the lane until its lease TTL. Any other turn keeps the throw it had.
 */
export function failedHarnessPersist(
  commit: HarnessSessionCommitPayload | undefined,
): (error: unknown) => PersistChatOutcome {
  return (error) => {
    if (!commit) throw error;
    logger.error("[sessionSimulation] harness turn persist threw", {
      chatSessionId: commit.chatSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { outcome: "failed", failureKind: "exception" };
  };
}

/** A rejected transcript cannot safely advance or resume the harness lane. */
export async function requirePersistedHarnessTurn(args: {
  outcome: PersistChatOutcome;
  commit: HarnessSessionCommitPayload | undefined;
  projectId: string;
  journeyRunId?: string;
  hostId?: string;
  bearer: string;
}): Promise<void> {
  const { commit, outcome } = args;
  if (
    !commit ||
    outcome.outcome === "saved" ||
    outcome.outcome === "duplicate"
  ) {
    return;
  }
  // Release only this turn's claim. Never apply the rejected resume-state
  // commit. A release that fails is logged by the helper; the session still
  // fails below, so the run never continues on a lane it could not free.
  await releaseUncommittedHarnessLane({
    commit,
    projectId: args.projectId,
    bearer: args.bearer,
    ...(args.journeyRunId ? { journeyRunId: args.journeyRunId } : {}),
    ...(args.hostId ? { hostId: args.hostId } : {}),
  });
  throw Object.assign(
    new Error(
      "The conversation could not be saved. Start a new run to try again.",
    ),
    { details: { reason: "harness_persistence_failed" } },
  );
}
