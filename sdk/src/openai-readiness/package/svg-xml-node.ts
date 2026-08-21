/**
 * The Node XML parser for SVG dimension reads.
 *
 * WHY THIS IS ITS OWN MODULE. `@xmldom/xmldom` is banned from the browser
 * entry's import graph — the SDK asserts that in `browser-entry-guard.test.ts`,
 * because the XML/DSig stack is Node-only credential machinery that both bloats
 * the client bundle and drags crypto into it. A browser does not need it
 * anyway: `DOMParser` is native there, and `readImageDimensions` reaches for it
 * automatically.
 *
 * Node has no `DOMParser`, so this fills the gap, and it lives in a file that
 * only the Node entry imports. Keeping it out of `image-dimensions.ts` is what
 * lets the SAME dimension reader run in both runtimes.
 *
 * Node entry only. Never import this from `browser.ts`.
 */

import { DOMParser } from "@xmldom/xmldom";

import type { XmlDocumentLike, XmlParseResult } from "./image-dimensions.js";

/** The first line of an xmldom diagnostic — the rest is a position banner. */
function firstLine(message: unknown): string {
  return String(message)
    .split("\n")[0]
    .replace(/^\[xmldom [a-z]+\]\s*/, "");
}

/**
 * Parse XML with xmldom, treating EVERY diagnostic severity as malformed.
 *
 * The parser recovers by design: handed `<svg width="10">` with no end tag it
 * reports a WARNING and returns a usable tree, and handed an undefined entity
 * it reports an ERROR and does the same. Listening only for `fatalError` would
 * therefore accept documents that are not well-formed XML — which is exactly
 * what the portal rejects — and then read dimensions off a tree the parser
 * guessed at. Well-formed SVGs, including ones with a doctype, CDATA,
 * namespaces and nested groups, produce no diagnostics at all, so nothing
 * legitimate is caught here.
 */
export function xmldomParseXml(source: string): XmlParseResult {
  let problem: string | undefined;
  try {
    const document = new DOMParser({
      errorHandler: {
        warning: (message: unknown) => {
          problem ??= firstLine(message);
        },
        error: (message: unknown) => {
          problem ??= firstLine(message);
        },
        fatalError: (message: unknown) => {
          problem ??= firstLine(message);
        },
      },
    }).parseFromString(source, "image/svg+xml");

    if (problem) return { ok: false, reason: problem };
    return { ok: true, document: document as unknown as XmlDocumentLike };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}
