/**
 * Durable identity for the *active* Playground conversation.
 *
 * The Playground transcript is already persisted server-side, but nothing in
 * the browser remembered *which* conversation was on screen. A refresh — or the
 * full-page navigation an OAuth redirect performs — therefore dropped the user
 * into an empty chat next to a history rail that still listed the conversation
 * they had just been reading.
 *
 * The `?conversation=` query param is the *only* place that identity lives.
 * That is deliberate: it survives a refresh and an OAuth round trip (the return
 * path is captured as pathname + search, which is also how Electron's renderer
 * reload finds its way back), it is what the user's own Back/Forward and
 * bookmarks carry, and — the reason a browser-storage fallback was removed —
 * it means arriving at a bare `/playground` starts a NEW chat. Reopening the
 * last conversation on every visit is not something the URL can ask for by
 * accident.
 *
 * The id is not authorization. It is handed straight back to the chat-history
 * API, which re-checks ownership; a foreign or deleted id fails the fetch and
 * the caller starts fresh.
 */

/** Query param carrying the active conversation on `/playground`. */
export const PLAYGROUND_CONVERSATION_PARAM = "conversation";

/**
 * Read `?conversation=` out of a search string.
 *
 * Mirrors `parseSwarmSessionParams` in `app-navigation.ts`: blank and
 * whitespace-only values are treated as absent rather than as an id that will
 * certainly 404.
 */
export function readConversationParam(search: string): string | null {
  const value = new URLSearchParams(search).get(PLAYGROUND_CONVERSATION_PARAM);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Whether a restore is still owed for the current param.
 *
 * An empty transcript next to a param that names some *other* session is the
 * signature of "not restored yet" — either the first paint after a reload, or
 * the moment after the chat hook re-mints its session id because auth or the
 * project scope resolved late. Both must leave the URL alone: stripping the
 * param here would cancel the very restore the param exists to trigger.
 *
 * Once a restore has definitively failed the id stops being outstanding, so a
 * dead conversation cannot wedge the URL forever.
 */
export function isConversationRestoreOutstanding(input: {
  paramValue: string | null;
  chatSessionId: string;
  hasMessages: boolean;
  hasFailed: boolean;
}): boolean {
  if (input.paramValue === null) return false;
  if (input.hasFailed) return false;
  if (input.hasMessages) return false;
  return input.paramValue !== input.chatSessionId;
}

/**
 * What the URL should do for the current session state.
 *
 * Deliberately never returns "clear": an empty transcript is ambiguous (New
 * Chat, but also the chat hook's auth-bootstrap reset), and inferring a clear
 * from it would silently drop the conversation the user is mid-way through
 * restoring. Clearing is driven by the explicit reset signal instead — see
 * the hook's `clearConversation`.
 */
export function decideConversationUrlSync(input: {
  paramValue: string | null;
  chatSessionId: string;
  hasMessages: boolean;
  restorePending: boolean;
}): { kind: "set"; conversationId: string } | { kind: "noop" } {
  if (input.restorePending) return { kind: "noop" };
  if (!input.hasMessages) return { kind: "noop" };
  if (input.paramValue === input.chatSessionId) return { kind: "noop" };
  return { kind: "set", conversationId: input.chatSessionId };
}
