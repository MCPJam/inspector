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
    action: {
      label: "Open original",
      onClick: async () => {
        try {
          const detail = await getCachedChatHistoryDetail({
            chatSessionId: previousChatSessionId,
            projectId,
          });
          await reopen(detail);
        } catch {
          toast.error(
            "Couldn't reopen the original thread. It's still in your history."
          );
        }
      },
    },
  });
}
