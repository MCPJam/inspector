import { toast } from "sonner";
import { isHistoryNoticeDataPart } from "@/shared/history-notice";
import { isPluginServerUnavailableDataPart } from "@/shared/plugin-server-unavailable";
import {
  REASONING_EFFORT_NOTICE_DATA_PART_TYPE,
  REASONING_EFFORT_NOTICE_MESSAGE,
  isReasoningEffortNoticeDataPart,
} from "@/shared/reasoning-effort-notice";
import { useHistoryNoticeStore } from "@/stores/history-notice-store";
import { usePluginServerNoticeStore } from "@/stores/plugin-server-notice-store";

/**
 * Record a notice the stream carried about its turn, for the chat the part
 * names. A part names its chat because one from an earlier turn can arrive
 * after a reset, fork or thread switch; only an unnamed part falls back to the
 * live chat. Returns whether `part` was such a notice.
 *
 * - `data-history-notice`: earlier replies in this chat are not in the
 *   model's context this turn; the thread says so, once, inline.
 * - `data-plugin-server-unavailable`: plugin servers the turn ran without;
 *   the Playground's plugin notice says so.
 * - `data-reasoning-effort-notice`: the turn ran without its reasoning
 *   effort (a custom provider takes none); a toast says so. Every turn on
 *   such a model sends it, so the toast keeps one id and does not stack.
 */
export function noteTurnNoticePart(
  part: unknown,
  liveChatSessionId: string | null | undefined,
): boolean {
  if (isHistoryNoticeDataPart(part)) {
    const sessionId = part.data.chatSessionId ?? liveChatSessionId;
    if (sessionId) {
      useHistoryNoticeStore.getState().noteEarlierRepliesNotSent(sessionId);
    }
    return true;
  }
  if (isPluginServerUnavailableDataPart(part)) {
    const sessionId = part.data.chatSessionId ?? liveChatSessionId;
    if (sessionId) {
      usePluginServerNoticeStore
        .getState()
        .report(sessionId, part.data.servers);
    }
    return true;
  }
  if (isReasoningEffortNoticeDataPart(part)) {
    toast.info(REASONING_EFFORT_NOTICE_MESSAGE, {
      id: REASONING_EFFORT_NOTICE_DATA_PART_TYPE,
    });
    return true;
  }
  return false;
}
