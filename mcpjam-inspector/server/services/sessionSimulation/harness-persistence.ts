import type { PersistChatOutcome } from "../../utils/chat-ingestion.js";
import {
  releaseHarnessSessionState,
  type HarnessSessionCommitPayload,
} from "../../utils/harness/harness-session-state.js";

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
  // Release only this turn's claim. Never apply the rejected resume-state commit.
  await releaseHarnessSessionState({
    owner: {
      projectId: args.projectId,
      harnessId: commit.harnessId,
      ownerType: commit.ownerType,
      chatSessionId: commit.chatSessionId,
      ...(commit.scenarioId ? { scenarioId: commit.scenarioId } : {}),
      ...(args.journeyRunId ? { journeyRunId: args.journeyRunId } : {}),
      ...(args.hostId ? { hostId: args.hostId } : {}),
      ...(commit.executionScope
        ? { executionScope: commit.executionScope }
        : {}),
    },
    leaseId: commit.leaseId,
    bearer: args.bearer,
    signal: AbortSignal.timeout(5_000),
  });
  throw Object.assign(
    new Error(
      "The conversation could not be saved. Start a new run to try again.",
    ),
    { details: { reason: "harness_persistence_failed" } },
  );
}
