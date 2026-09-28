const HTML_PREAMBLE = /^(?:﻿|\s|<!--[\s\S]*?-->|<\?xml[\s\S]*?\?>)+/i;

/** Markup that can only be a document, once any preamble is stripped. */
const MARKUP_OPENER = /^<(?:!doctype\s+html|html|head|body|title)\b/i;

/**
 * The one marker conclusive wherever it appears. `<html>` is NOT: error text
 * quotes it ("expected <html> but the tool returned a number"), and treating
 * that as a document would summarize a perfectly readable message away.
 */
const DOCTYPE_MARKER = /<!doctype\s+html/i;

/**
 * Detection has to survive bodies that are not well-formed documents. A
 * truncated or streamed response never reaches `</html>`; a proxy may prepend
 * a comment or an XML declaration; a fragment may begin at `<head>` with no
 * doctype at all. Matching only "starts with `<html`" or "ends with
 * `</html>`" let all of those through to be rendered as raw markup — the
 * exact failure this function exists to prevent.
 *
 * The start-anchored check runs against the preamble-stripped body so that
 * ordinary prose which merely mentions a tag ("expected `<html>` here") is not
 * mistaken for a document.
 */
export function looksLikeErrorPage(trimmed: string): boolean {
  if (DOCTYPE_MARKER.test(trimmed)) return true;
  if (/<\/html>\s*$/i.test(trimmed)) return true;
  return MARKUP_OPENER.test(trimmed.replace(HTML_PREAMBLE, ""));
}
