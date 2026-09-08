/**
 * Which page tool produced this card, read FROM THE CARD.
 *
 * The obvious implementation is a lookup: keep the turn's page tools in a
 * store, and resolve `webmcp_bookSlot` against it when rendering. That is
 * exactly what must not happen. A store answers for the browser as it is NOW —
 * so a conversation scrolled back after the model navigated elsewhere would
 * attribute an old card to whatever tool happens to carry that name today, or
 * to nothing at all once the page is gone. The card would change its own
 * history under the reader.
 *
 * So attribution rides INSIDE the tool result, where the server put it. A tool
 * result is message content: it persists in the transcript for free, survives a
 * reload, and still says the right thing a week later.
 *
 * The fallback is the turn's persisted `pageToolsAtTurn` record — also a fact
 * about the turn rather than about the browser — for a card written before the
 * result carried its own attribution. The live store is never consulted.
 */
import type { MintedPageToolRecord } from "@/shared/declared-tools";
import {
  isWebmcpPageToolName,
  safeDeclaredOrigin,
  sanitizeDeclaredText,
} from "@/shared/declared-tools";

/**
 * How much of a page's own tool name a card will show.
 *
 * A name is a place a page can write a sentence. It is rendered as the label of
 * the thing a person is being asked to approve, so it gets the same treatment
 * as a tool description: no control characters, no bidi overrides, no fence
 * markers, and short enough that it cannot push the rest of the card off screen.
 */
const RAW_NAME_MAX_CHARS = 128;

/** A page's own tool name, made safe to render as a label. */
function safeRawName(rawName: string): string | undefined {
  const cleaned = sanitizeDeclaredText(rawName, RAW_NAME_MAX_CHARS);
  return cleaned.length > 0 ? cleaned : undefined;
}

export interface PageToolAttribution {
  /** The page's own name for the tool — what a person recognizes. */
  rawName: string;
  /** Scheme + host, already reduced; safe to render outside any fence. */
  origin?: string;
  /** Which document generation, when the result carried one. */
  navCounter?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the attribution the server attached to a page-tool result.
 *
 * Defensive about every field: this is read off a persisted transcript that may
 * predate the field, and a card that renders is always better than a card that
 * throws. The origin is re-reduced through `safeDeclaredOrigin` rather than
 * trusted — it is rendered outside the page-content fence, where a path or a
 * query string would be a sentence addressed to whoever is reading.
 */
export function pageToolAttributionFrom(
  output: unknown,
): PageToolAttribution | undefined {
  if (!isRecord(output)) return undefined;
  const attribution = output.pageTool;
  if (!isRecord(attribution)) return undefined;
  if (typeof attribution.rawName !== "string") return undefined;
  const rawName = safeRawName(attribution.rawName);
  if (!rawName) return undefined;
  const origin =
    typeof attribution.origin === "string"
      ? safeDeclaredOrigin(attribution.origin)
      : undefined;
  return {
    rawName,
    ...(origin && origin !== "unknown" ? { origin } : {}),
    ...(typeof attribution.navCounter === "number"
      ? { navCounter: attribution.navCounter }
      : {}),
  };
}

/**
 * Attribution for one rendered tool part.
 *
 * Order is the whole point: the RESULT first (a fact about this call), then the
 * turn's own persisted record (a fact about this turn), and never the live
 * browser (a fact about right now, which is the wrong question).
 */
export function resolvePageToolAttribution(args: {
  toolName: string;
  output: unknown;
  /** The turn's persisted `pageToolsAtTurn`, when the trace carried one. */
  turnRecords?: readonly MintedPageToolRecord[];
}): PageToolAttribution | undefined {
  if (!isWebmcpPageToolName(args.toolName)) return undefined;
  // THE PREFIX IS THE NAMESPACE, and the turn's record is the exact answer.
  //
  // `webmcp_` means "the open page declared this" — to the model, through the
  // declared-tools prompt section, and here, where it decides whether a result
  // may put a page name and an origin chip on its own card. That only holds
  // because `prepareChatV2` RESERVES the prefix: a tool from an MCP server, an
  // app, the UI set or a skill that claims one of these names is dropped rather
  // than advertised, so nothing else can arrive carrying it.
  //
  // Where the turn also recorded what it advertised, that record is checked
  // too. It is the narrower fact — this turn, this name — and it costs nothing
  // to prefer it over a namespace rule enforced a process away.
  const records = args.turnRecords;
  const record = records?.find((entry) => entry.name === args.toolName);
  if (records && !record) return undefined;
  const fromResult = pageToolAttributionFrom(args.output);
  if (fromResult) return fromResult;
  if (!record) return undefined;
  const origin = record.origin ? safeDeclaredOrigin(record.origin) : undefined;
  const rawName = safeRawName(record.rawName);
  if (!rawName) return undefined;
  return {
    rawName,
    ...(origin && origin !== "unknown" ? { origin } : {}),
    ...(record.binding ? { navCounter: record.binding.navCounter } : {}),
  };
}
