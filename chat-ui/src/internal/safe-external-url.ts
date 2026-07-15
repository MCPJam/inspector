/**
 * URL safety for rendering links sourced from UNTRUSTED content (tool output,
 * model text, MCP server payloads). A string in a tool result is not a
 * vetted URL — `javascript:`, `data:`, `vbscript:`, `file:` and unparseable
 * values must never become a clickable link.
 *
 * Policy: only absolute `https:` URLs pass. We intentionally do NOT allow
 * plain `http:` (even to localhost).
 *
 * Ported verbatim from the inspector (`@/lib/safe-external-url`) so the
 * read-only renderer keeps the exact same link-safety policy.
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
 * Filter a candidate list down to URLs safe to render as user-clickable
 * links, deduped and order-preserving. Tolerant of non-array input.
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

/**
 * Image-src safety for UNTRUSTED transcript file parts. Rendering an
 * attacker-controlled URL into `<img src>` forces the browser to fetch it,
 * leaking client metadata (IP, headers) to an arbitrary host. Allow only
 * inline `data:image/*` (no network fetch) and absolute `https:` images;
 * the caller falls back to a non-fetching representation otherwise.
 */
export function isSafeImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (/^data:image\//i.test(value)) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
