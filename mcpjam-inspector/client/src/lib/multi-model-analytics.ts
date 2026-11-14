import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";

const REBUILD_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

let loaded: readonly ChatHistorySession[] = [];

/** The Sessions rail's personal list, as last loaded on this page. */
export function setLoadedHistorySessions(sessions: readonly ChatHistorySession[]) {
  loaded = sessions;
}

const normalize = (text: string) => text.trim().replace(/\s+/g, " ");

/**
 * Whether this first prompt already ran side by side recently: at least two
 * saved chats from the last 14 days open with it. Computed in the browser so
 * no prompt text leaves it; the event carries only the answer.
 */
export function isRebuiltLineup(
  prompt: string,
  now: number,
  sessions: readonly ChatHistorySession[] = loaded,
): boolean {
  const text = normalize(prompt);
  if (!text) return false;
  const matches = sessions.filter((session) => {
    if (now - session.lastActivityAt > REBUILD_WINDOW_MS) return false;
    const preview = normalize(session.firstMessagePreview);
    return preview.length > 0 && text.startsWith(preview);
  });
  return matches.length >= 2;
}
