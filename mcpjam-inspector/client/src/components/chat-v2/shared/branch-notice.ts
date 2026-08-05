import { toast } from "@/lib/toast";
import { getCachedChatHistoryDetail } from "@/components/chat-v2/history/chat-history-prefetch";
import type { ChatHistoryDetailResponse } from "@/lib/apis/web/chat-history-api";

/**
 * Tell the user a rewind branched the thread, and offer a way back.
 *
 * A branch is otherwise invisible: `onReset("fork")` only clears internal
 * queues, and no lineage field exists in the schema, so the original and the
 * branch sit in the history rail with no visible relationship. This notice is
 * the only signal.
 *
 * Reopening needs a full `ChatHistoryDetailSession` — `messagesBlobUrl`,
 * `resumeConfig`, `version` — so the action fetches the detail (hitting the
 * same dedup cache the history rail uses) and hands it to the caller's own
 * restore path. On failure it says so rather than leaving a dead button.
 */
export function showBranchCreatedNotice(options: {
  previousChatSessionId: string;
  projectId?: string;
  reopen: (detail: ChatHistoryDetailResponse) => Promise<void>;
}): void {
  const { previousChatSessionId, projectId, reopen } = options;

  toast.success("New branch created", {
    description: "The original thread is still in your history.",
    // Sonner's default (~4s) is too short for the ONLY path back to the
    // original thread: the branch has no lineage field in the schema, so once
    // this toast is gone the relationship between the two threads is invisible.
    // Give the user time to notice it and decide.
    duration: 15000,
    action: {
      label: "Open original",
      onClick: async () => {
        try {
          const detail = await getCachedChatHistoryDetail({
            chatSessionId: previousChatSessionId,
            projectId,
          });
          // The fetch resolving is not the same as it succeeding — the API
          // reports failure in-band as `{ ok: false }`. Passing that straight
          // to `reopen` sent a payload with no `session` into
          // `loadHistorySession`, which surfaced as its generic catch-all
          // message instead of this one.
          if (!detail?.ok) {
            throw new Error(
              `chat history detail returned ok: false for ${previousChatSessionId}`
            );
          }
          await reopen(detail);
        } catch (error) {
          // Logged so "the detail fetch failed" and "the restore path failed"
          // are distinguishable in a console; the toast text is deliberately
          // the same for both, since the user's options are identical.
          console.error("Failed to reopen the original thread", error);
          toast.error(
            "Couldn't reopen the original thread. It's still in your history."
          );
        }
      },
    },
  });
}
