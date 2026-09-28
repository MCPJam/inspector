/**
 * Transient SSE data part telling the browser that earlier assistant replies
 * in this conversation are not part of what the model is shown this turn —
 * the server could not confirm them as its own (see
 * `server/utils/history-provenance.ts`). The chat shows one small inline
 * notice for it, so a model that no longer "remembers" an earlier reply reads
 * as explained rather than as forgetting.
 *
 * Transient, not persisted: the server sends it on every turn it applies.
 */
export const HISTORY_NOTICE_DATA_PART_TYPE = "data-history-notice" as const;

export type HistoryNoticeReason = "earlier_replies_not_sent";

export interface HistoryNoticeDataPart {
  type: typeof HISTORY_NOTICE_DATA_PART_TYPE;
  data: {
    reason: HistoryNoticeReason;
    /**
     * The chat the turn belongs to. The browser records the notice for it,
     * not for whichever chat happens to be open when the part arrives.
     */
    chatSessionId?: string;
  };
}

export const HISTORY_NOTICE_MESSAGE =
  "Earlier replies in this chat aren't sent to the model.";

export function isHistoryNoticeDataPart(
  value: unknown,
): value is HistoryNoticeDataPart {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== HISTORY_NOTICE_DATA_PART_TYPE) return false;
  const data = candidate.data;
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  return (
    record.reason === "earlier_replies_not_sent" &&
    (record.chatSessionId === undefined ||
      (typeof record.chatSessionId === "string" &&
        record.chatSessionId.length > 0))
  );
}
