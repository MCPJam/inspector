import {
  persistChatSessionToConvex,
  type PersistChatOutcome,
} from "../../utils/chat-ingestion.js";
import {
  releaseUncommittedHarnessLane,
  type HarnessSessionCommitPayload,
} from "../../utils/harness/harness-session-state.js";

/** The write landed, or the backend recognized it as already applied. */
export function persistLanded(outcome: PersistChatOutcome): boolean {
  return outcome.outcome === "saved" || outcome.outcome === "duplicate";
}

/**
 * One v1 chat turn's harness lane.
 *
 * The route persists harness turns itself (caller mode), so the commit the
 * harness hands back rides the turn's `/ingest-chat` write and the transcript
 * and lane advance together. A commit no write has landed is released by lease
 * id without being applied, so the caller's next turn is not refused until the
 * lease TTL and the lane never resumes past the saved conversation.
 */
export function trackHarnessLane(lane: { projectId: string; bearer: string }) {
  let unsettled: HarnessSessionCommitPayload | undefined;
  return {
    /** The commit the turn handed back; absent unless it ran a harness. */
    adopt(commit: HarnessSessionCommitPayload | undefined): void {
      unsettled = commit;
    },
    /** `persistChatSessionToConvex`, carrying the commit until a write lands. */
    async persist(
      ...[options, c]: Parameters<typeof persistChatSessionToConvex>
    ): Promise<PersistChatOutcome> {
      const outcome = await persistChatSessionToConvex(
        unsettled ? { ...options, harnessSessionCommit: unsettled } : options,
        c,
      );
      if (persistLanded(outcome)) unsettled = undefined;
      return outcome;
    },
    /** Every exit awaits this, so the caller's next turn cannot race it. */
    async releaseIfUnsettled(): Promise<void> {
      if (!unsettled) return;
      await releaseUncommittedHarnessLane({ commit: unsettled, ...lane });
    },
  };
}
