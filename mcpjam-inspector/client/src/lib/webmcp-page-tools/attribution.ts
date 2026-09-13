/**
 * A card's page-tool identity comes from the call itself, never the live page.
 * Inspector aliases carry attribution in call metadata (including pending and
 * approval states) and results. Agent-browser tools carry it in their results.
 * Both survive navigation and reopening the saved conversation.
 */
import { isPageToolAlias } from "@/shared/client-fulfilled-tools";
import { readPageToolAttributionMetadata } from "@/shared/mcp-tool-origin-metadata";
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
 * Attribution for one rendered tool part, from its recorded call or result.
 * The live browser can already be on another page.
 */
export function resolvePageToolAttribution(args: {
  toolName: string;
  output: unknown;
  callProviderMetadata?: unknown;
}): PageToolAttribution | undefined {
  if (isPageToolAlias(args.toolName)) {
    return (
      pageToolAttributionFrom({
        pageTool: readPageToolAttributionMetadata(args.callProviderMetadata),
      }) ?? pageToolAttributionFrom(args.output)
    );
  }
  if (!isWebmcpPageToolName(args.toolName)) return undefined;
  // THE PREFIX IS THE NAMESPACE.
  //
  // `webmcp_` means "the open page declared this" — to the model, through the
  // declared-tools prompt section, and here, where it decides whether a result
  // may put a page name and an origin chip on its own card. That only holds
  // because `prepareChatV2` RESERVES the prefix: a tool from an MCP server, an
  // app, the UI set or a skill that claims one of these names is dropped rather
  // than advertised, so nothing else can arrive carrying it.
  return pageToolAttributionFrom(args.output);
}
