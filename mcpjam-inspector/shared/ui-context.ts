/**
 * Per-turn UI orientation context.
 *
 * The agent drives the user's screen, but the user drives it too — they
 * click around between turns. Tool results only tell the model about changes
 * IT made, so without this the model's picture of "where we are" is right
 * only until the user touches anything.
 *
 * ## Why this rides on the message, not the system prompt
 *
 * The obvious place is the system prompt. It is the wrong place: the system
 * prompt is the front of the cacheable prefix, so a value that changes every
 * turn invalidates the cache for the ENTIRE conversation, every request.
 * Anthropic's cache is prefix-based — appending is free, rewriting anything
 * earlier is not.
 *
 * So the context travels as a data part on the outgoing USER message:
 * append-only, and every earlier turn's bytes stay exactly as they were. The
 * cost is one small block per turn, which was never cached anyway.
 *
 * Historical blocks are left alone on purpose. "Where the user was at turn
 * three" was true when written, and the sequence is genuinely useful to the
 * model — rewriting or pruning them mid-session is the thing that would
 * break the cache.
 */

/** Data-part type. `data-` prefix is the AI SDK's own convention. */
export const UI_CONTEXT_PART_TYPE = "data-ui-context";

/**
 * Envelope markers. Exact, unique, and matched as WHOLE text parts — never
 * substring-replaced — so a user who types the marker into chat keeps their
 * message intact. See `isRenderedUiContextText`.
 */
export const UI_CONTEXT_OPEN = "[mcpjam-ui-context]";
export const UI_CONTEXT_CLOSE = "[/mcpjam-ui-context]";

/** Hard cap on the rendered block. Orientation, not a state dump. */
export const UI_CONTEXT_MAX_CHARS = 2048;

export interface UiContextPayload {
  /** Current SPA pathname, e.g. "/playground". */
  path: string;
  /** Resolved tab segment, e.g. "playground" (see `pathnameToActiveTab`). */
  activeTab: string;
  /** Names (never ids/secrets) of the servers currently selected. */
  selectedServers?: string[];
  /** ISO timestamp — the model can tell stale context from fresh. */
  timestamp: string;
}

export interface UiContextDataPart {
  type: typeof UI_CONTEXT_PART_TYPE;
  data: UiContextPayload;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Validate an inbound payload. Wide at the boundary: this arrives in a
 * client-supplied message part, so nothing here is trusted. Returns null
 * rather than throwing — a malformed orientation block must not 400 a turn
 * the user is waiting on; the model simply goes without it.
 */
export function parseUiContextPayload(value: unknown): UiContextPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.path !== "string" || raw.path.length === 0) return null;
  if (typeof raw.activeTab !== "string" || raw.activeTab.length === 0) {
    return null;
  }
  if (typeof raw.timestamp !== "string") return null;
  if (raw.selectedServers !== undefined && !isStringArray(raw.selectedServers)) {
    return null;
  }
  return {
    path: raw.path,
    activeTab: raw.activeTab,
    timestamp: raw.timestamp,
    ...(raw.selectedServers ? { selectedServers: raw.selectedServers } : {}),
  };
}

/**
 * Render the payload as the text the model reads. Returns null when the
 * payload is unusable, so the caller drops the part instead of shipping a
 * half-formed block.
 */
export function renderUiContextText(value: unknown): string | null {
  const payload = parseUiContextPayload(value);
  if (!payload) return null;
  const lines = [
    UI_CONTEXT_OPEN,
    "The user's screen right now (they may have navigated it themselves since your last turn):",
    `- Screen: ${payload.activeTab} (${payload.path})`,
  ];
  if (payload.selectedServers?.length) {
    lines.push(`- Selected servers: ${payload.selectedServers.join(", ")}`);
  } else if (payload.selectedServers) {
    lines.push("- Selected servers: none");
  }
  lines.push(UI_CONTEXT_CLOSE);
  const text = lines.join("\n");
  return text.length > UI_CONTEXT_MAX_CHARS
    ? `${text.slice(0, UI_CONTEXT_MAX_CHARS - UI_CONTEXT_CLOSE.length - 1)}\n${UI_CONTEXT_CLOSE}`
    : text;
}

/**
 * Whether a text part is one WE rendered.
 *
 * Whole-string match on both markers, deliberately: persistence strips these
 * from stored history, and a substring match would let
 * "how do I use [mcpjam-ui-context]?" delete part of a user's own message.
 * An exact match can only be produced by `renderUiContextText`.
 */
export function isRenderedUiContextText(text: unknown): boolean {
  return (
    typeof text === "string" &&
    text.startsWith(UI_CONTEXT_OPEN) &&
    text.trimEnd().endsWith(UI_CONTEXT_CLOSE)
  );
}
