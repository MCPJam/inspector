/**
 * URL safety for rendering links sourced from UNTRUSTED content (tool output,
 * model text, MCP server payloads). A string in a tool result is not a
 * vetted URL — `javascript:`, `data:`, `vbscript:`, `file:` and unparseable
 * values must never become a clickable link.
 *
 * Policy: only absolute `https:` URLs pass. We intentionally do NOT allow
 * plain `http:` (even to localhost): device-flow verification URLs are always
 * https, and a clickable `http://localhost:<port>` link would point a user at
 * their OWN machine, not the sandbox — surprising at best, an SSRF-flavored
 * footgun at worst.
 */
export function isSafeExternalLinkUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:";
}

/**
 * Filter a candidate list (e.g. a tool result's `authUrls`) down to URLs safe
 * to render as user-clickable links, deduped and order-preserving. Tolerant
 * of a non-array input (returns []).
 */
export function filterSafeExternalLinkUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (isSafeExternalLinkUrl(item) && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}
