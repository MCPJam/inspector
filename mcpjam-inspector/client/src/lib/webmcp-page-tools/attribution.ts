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
} from "@/shared/declared-tools";

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
  const rawName = attribution.rawName;
  if (typeof rawName !== "string" || !rawName) return undefined;
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
  const fromResult = pageToolAttributionFrom(args.output);
  if (fromResult) return fromResult;
  const record = args.turnRecords?.find(
    (entry) => entry.name === args.toolName,
  );
  if (!record) return undefined;
  const origin = record.origin ? safeDeclaredOrigin(record.origin) : undefined;
  return {
    rawName: record.rawName,
    ...(origin && origin !== "unknown" ? { origin } : {}),
    ...(record.binding ? { navCounter: record.binding.navCounter } : {}),
  };
}
