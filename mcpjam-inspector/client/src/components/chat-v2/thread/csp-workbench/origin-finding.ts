/**
 * Does the origin a server ASKED for match the one MCPJam actually serves its
 * view from?
 *
 * Deliberately informational rather than a violation. `_meta.ui.domain` is
 * host-specific by design — Claude wants
 * `<sha256(connectorUrl)[:32]>.claudemcpcontent.com`, ChatGPT a
 * `*.web-sandbox.oaiusercontent.com` label — and a server can only declare
 * ONE string. So a value that does not match here is the normal case for any
 * server already shipping to a production host, not a defect. What is worth
 * saying is the consequence: an allowlist keyed on that string will not match
 * requests coming from MCPJam.
 */
export type OriginFindingKind =
  | "match"
  | "mismatch"
  /** Not a hostname at all — a scheme, a path, or a port crept in. */
  | "malformed";

/**
 * A bare hostname: dot-separated labels of letters, digits and hyphens.
 * Mirrors what `_meta.ui.domain` is specified to carry (Claude's
 * `{hash}.claudemcpcontent.com`), and rejects the mistakes that actually get
 * made — a full URL, a trailing path, an explicit port.
 */
const BARE_HOSTNAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function classifyDeclaredDomain(
  declared: string | null | undefined,
  assignedOrigin: string | undefined,
): OriginFindingKind | null {
  if (!declared) return null;
  const value = declared.trim().toLowerCase();
  if (!BARE_HOSTNAME.test(value)) return "malformed";
  if (!assignedOrigin) return "mismatch";
  let assignedHost: string;
  try {
    assignedHost = new URL(assignedOrigin).hostname.toLowerCase();
  } catch {
    return "mismatch";
  }
  return value === assignedHost ? "match" : "mismatch";
}
