/**
 * The one shape a sandbox origin may take: the origin of an http(s) URL.
 * Shared so the server's runtime `MCPJAM_SANDBOX_ORIGIN` and the client's
 * build-time `VITE_MCPJAM_SANDBOX_ORIGIN` are validated by the same rule.
 */
export function sandboxOriginOf(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    // Not a URL at all: the same answer as one with the wrong scheme.
    return null;
  }
}
