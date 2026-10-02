import { create } from "zustand";

/**
 * Chats whose earlier assistant replies the server reported as not sent to
 * the model (`data-history-notice`, see `shared/history-notice.ts`), keyed by
 * chat session id. The chat thread reads it to show one inline notice.
 *
 * Kept for the life of the page: a reply left out of one turn's context is
 * left out of every later turn of the same chat.
 */
interface HistoryNoticeState {
  chats: Record<string, true>;
  noteEarlierRepliesNotSent: (chatSessionId: string) => void;
}

export const useHistoryNoticeStore = create<HistoryNoticeState>((set) => ({
  chats: {},
  noteEarlierRepliesNotSent: (chatSessionId) =>
    set((state) =>
      state.chats[chatSessionId]
        ? state
        : { chats: { ...state.chats, [chatSessionId]: true } },
    ),
}));

/** Whether this chat's earlier replies are not sent to the model. */
export function useEarlierRepliesNotSent(
  chatSessionId: string | undefined,
): boolean {
  return useHistoryNoticeStore((state) =>
    chatSessionId ? state.chats[chatSessionId] === true : false,
  );
}
