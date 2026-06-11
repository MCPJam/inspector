/**
 * URL safety for rendering links sourced from UNTRUSTED content (tool output,
 * model text, MCP server payloads). A string in a tool result is not a
 * vetted URL — `javascript:`, `data:`, `vbscript:`, `file:` and unparseable
 * values must never become a clickable link.
 *
 * Policy: only absolute `https:` URLs pass. Plain `http:` is allowed solely
 * for loopback hosts, because device-flow logins occasionally print a
 * `http://localhost:<port>` callback; every other host must be https.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isSafeExternalLinkUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return true;
  return false;
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
