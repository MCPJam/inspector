/**
 * Durable identity for the *active* Playground conversation.
 *
 * The Playground transcript is already persisted server-side, but until now
 * nothing in the browser remembered *which* conversation was on screen. A
 * refresh — or the full-page navigation an OAuth redirect performs — therefore
 * dropped the user into an empty chat next to a history rail that still listed
 * the conversation they had just been reading.
 *
 * This module owns the two places that identity can live:
 *
 * - the `?conversation=` query param, which is the source of truth because it
 *   survives OAuth (the return path is captured as pathname + search) and is
 *   what the user's own back/forward/bookmark actions carry; and
 * - a single localStorage entry, consulted **only** when the param is missing,
 *   which covers the paths that re-enter `/playground` bare — Electron's
 *   post-OAuth renderer reload, legacy return markers, a hand-trimmed URL.
 *
 * Neither is authorization. Both hold an opaque id that is handed straight back
 * to the chat-history API, which re-checks ownership; a foreign or deleted id
 * fails the fetch and the caller starts fresh.
 */

/** Query param carrying the active conversation on `/playground`. */
export const PLAYGROUND_CONVERSATION_PARAM = "conversation";

const STORAGE_KEY = "mcpjam:playground-active-conversation:v1";

/**
 * Fallback entries older than this are ignored. A stale id is not dangerous
 * (the fetch would just 404), but resurrecting a week-old chat because the user
 * happened to arrive at a bare `/playground` is surprising, and the param
 * covers every case where resuming is actually intended.
 */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Persisted shape of the fallback entry. */
export type ActivePlaygroundConversation = {
  chatSessionId: string;
  /** `null` for local/unsynced mode, where there is no Convex project. */
  projectId: string | null;
  updatedAt: number;
};

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

function normalizeProjectId(projectId: string | null | undefined): string | null {
  const trimmed = projectId?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Remember the active conversation for surfaces that re-enter `/playground`
 * without the query param. Best-effort: storage can throw (private mode, quota)
 * and losing the fallback only costs us a restore the param would have handled.
 */
export function writeActivePlaygroundConversation(entry: {
  chatSessionId: string;
  projectId: string | null | undefined;
  updatedAt: number;
}): void {
  if (typeof window === "undefined") return;
  const chatSessionId = entry.chatSessionId.trim();
  if (!chatSessionId) return;
  try {
    const payload: ActivePlaygroundConversation = {
      chatSessionId,
      projectId: normalizeProjectId(entry.projectId),
      updatedAt: entry.updatedAt,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort: see the doc comment above.
  }
}

/** Forget the active conversation (reset, archive, or a restore that failed). */
export function clearActivePlaygroundConversation(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort: see {@link writeActivePlaygroundConversation}.
  }
}

/**
 * The stored conversation id, but only when it belongs to the caller's current
 * project.
 *
 * The project check is the important half: without it, switching projects and
 * landing on a bare `/playground` would try to reopen a conversation from the
 * project the user just left. A mismatch returns `null` rather than clearing
 * the entry, so switching back still finds it.
 */
export function readActivePlaygroundConversation(
  currentProjectId: string | null | undefined,
  now: number,
): string | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const entry = parsed as Partial<ActivePlaygroundConversation>;
  const chatSessionId =
    typeof entry.chatSessionId === "string" ? entry.chatSessionId.trim() : "";
  if (!chatSessionId) return null;
  if (typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt)) {
    return null;
  }
  if (now - entry.updatedAt > STALE_AFTER_MS) return null;

  const storedProjectId =
    typeof entry.projectId === "string" ? normalizeProjectId(entry.projectId) : null;
  if (storedProjectId !== normalizeProjectId(currentProjectId)) return null;

  return chatSessionId;
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
 * {@link clearActivePlaygroundConversation}'s callers.
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
