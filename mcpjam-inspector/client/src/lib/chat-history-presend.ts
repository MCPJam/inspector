import type { ChatHistoryStateSession } from "@/lib/apis/web/chat-history-api";

/**
 * How long Send waits to sync a resumed thread before reporting the sync as
 * failed. Without a bound, a stalled read held the message back indefinitely.
 */
export const PRESEND_SYNC_TIMEOUT_MS = 4_000;

/**
 * Whether the thread's live session subscription already holds what the
 * pre-send state read would return: the same history row and conversation, at
 * a version the persistence cursor has reached. Send then goes at once. While
 * the subscription is paused (during a stream) or has not delivered yet, this
 * is false and Send reads the state first, as before.
 */
export function presendStateIsCurrent({
  activeHistorySessionId,
  chatSessionId,
  live,
  resumedVersion,
}: {
  activeHistorySessionId: string | null | undefined;
  chatSessionId: string | null | undefined;
  live:
    | Pick<ChatHistoryStateSession, "_id" | "chatSessionId" | "version">
    | null
    | undefined;
  resumedVersion: number | null;
}): boolean {
  return (
    Boolean(activeHistorySessionId) &&
    live != null &&
    live._id === activeHistorySessionId &&
    live.chatSessionId === chatSessionId &&
    resumedVersion !== null &&
    live.version <= resumedVersion
  );
}

/** Bound the pre-send state read; expiry is a sync failure, never a detach. */
export function withPresendSyncTimeout<T>(
  read: Promise<T>,
  timeoutMs = PRESEND_SYNC_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`Chat history sync took longer than ${timeoutMs} ms`)),
      timeoutMs,
    );
    read.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
