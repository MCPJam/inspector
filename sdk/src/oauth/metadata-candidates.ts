/**
 * Where OAuth metadata for an MCP server lives, and how to walk the places.
 *
 * Every discovery path in the SDK, the probe, the readiness runners, the
 * conformance suite, the browser auth flow, the debug state machines and the
 * XAA test bench, builds its well-known URLs here, so a change to the order a
 * protocol version prescribes lands everywhere at once. Callers keep their own
 * transport (timeouts, SSRF guards, which headers go out) and their own result
 * shape; this module only knows URLs and the order to try them in.
 *
 * Dependency-free and browser-safe: string and `URL` handling only.
 */

import type { OAuthProtocolVersion } from "./state-machines/types.js";

const PROTECTED_RESOURCE_METADATA = "oauth-protected-resource";

function originAndPath(input: string | URL): { origin: string; path: string } {
  const url = typeof input === "string" ? new URL(input) : input;
  // One trailing slash is not part of the identifier the well-known suffix
  // carries: `https://host/mcp/` and `https://host/mcp` share a document.
  return { origin: url.origin, path: url.pathname.replace(/\/$/, "") };
}

/**
 * RFC 9728 §3.1 Protected Resource Metadata URLs for a resource: the
 * path-suffixed form, then the origin root. For a resource at the origin root
 * both entries are the same URL; callers that walk them decide whether to
 * dedupe. The query is dropped. Throws on an unparseable URL.
 */
export function protectedResourceMetadataUrls(
  resourceUrl: string | URL
): [pathSuffixed: string, root: string] {
  const { origin, path } = originAndPath(resourceUrl);
  const root = `${origin}/.well-known/${PROTECTED_RESOURCE_METADATA}`;
  return [`${root}${path}`, root];
}

/**
 * The well-known spellings of authorization-server metadata (RFC 8414 §3.1,
 * OpenID Connect Discovery §4). "insert" puts the well-known segment between
 * the origin and the issuer's path; "append" puts it after the path; "root"
 * drops the path.
 */
const AUTHORIZATION_SERVER_METADATA_FORMS = {
  "oauth-insert": { kind: "oauth", placement: "insert" },
  "oauth-root": { kind: "oauth", placement: "root" },
  "oidc-insert": { kind: "oidc", placement: "insert" },
  "oidc-append": { kind: "oidc", placement: "append" },
  "oidc-root": { kind: "oidc", placement: "root" },
} as const;

export type AuthorizationServerMetadataForm =
  keyof typeof AUTHORIZATION_SERVER_METADATA_FORMS;

export type AuthorizationServerMetadataKind = "oauth" | "oidc";

export interface AuthorizationServerMetadataCandidate {
  url: string;
  kind: AuthorizationServerMetadataKind;
}

const WELL_KNOWN_NAME: Record<AuthorizationServerMetadataKind, string> = {
  oauth: "oauth-authorization-server",
  oidc: "openid-configuration",
};

/** The orders MCP's authorization spec prescribes. */
export const MCP_AUTHORIZATION_SERVER_METADATA_FORMS = {
  /**
   * 2025-11-25 and 2026-07-28: OAuth path insertion, OIDC path insertion,
   * OIDC path appending, and no root fallback for an issuer with a path.
   */
  current: ["oauth-insert", "oidc-insert", "oidc-append"],
  /** 2025-03-26 and 2025-06-18: RFC 8414 only, path insertion then root. */
  legacy: ["oauth-insert", "oauth-root"],
} as const satisfies Record<
  string,
  readonly AuthorizationServerMetadataForm[]
>;

export function mcpAuthorizationServerMetadataForms(
  protocolVersion: OAuthProtocolVersion
): readonly AuthorizationServerMetadataForm[] {
  switch (protocolVersion) {
    case "2025-03-26":
    case "2025-06-18":
      return MCP_AUTHORIZATION_SERVER_METADATA_FORMS.legacy;
    case "2025-11-25":
    case "2026-07-28":
      return MCP_AUTHORIZATION_SERVER_METADATA_FORMS.current;
    default: {
      const exhaustive: never = protocolVersion;
      return exhaustive;
    }
  }
}

/**
 * Authorization-server metadata URLs for an issuer, in `forms` order. An
 * issuer at the origin root collapses insertion, appending and root onto the
 * same URL, so duplicates are dropped and the first spelling wins. The query
 * is dropped. Throws on an unparseable issuer.
 */
export function authorizationServerMetadataUrls(
  issuer: string | URL,
  forms: readonly AuthorizationServerMetadataForm[]
): AuthorizationServerMetadataCandidate[] {
  const { origin, path } = originAndPath(issuer);
  const seen = new Set<string>();
  const candidates: AuthorizationServerMetadataCandidate[] = [];
  for (const form of forms) {
    const { kind, placement } = AUTHORIZATION_SERVER_METADATA_FORMS[form];
    const name = WELL_KNOWN_NAME[kind];
    const url =
      placement === "insert"
        ? `${origin}/.well-known/${name}${path}`
        : placement === "append"
          ? `${origin}${path}/.well-known/${name}`
          : `${origin}/.well-known/${name}`;
    if (seen.has(url)) continue;
    seen.add(url);
    candidates.push({ url, kind });
  }
  return candidates;
}

/**
 * Resolve a `resource_metadata` pointer, or refuse it.
 *
 * THE POINTER IS ATTACKER-CONTROLLED. It arrives in a `WWW-Authenticate` header
 * from the server under test, and `new URL()` will happily accept
 * `http://169.254.169.254/…` or a `file:` URL. In a hosted run the pinned
 * transport would refuse it, but these functions accept any `fetchFn`, so the
 * pointer is validated here rather than trusted to the caller's transport.
 *
 * Same origin is not an arbitrary narrowing: RFC 9728 constructs the metadata
 * URL from the resource identifier itself, and requires the document's
 * `resource` to equal the request URL. A pointer to another origin cannot
 * satisfy that, so following it could only ever produce a document we would
 * then reject.
 *
 * Returns `undefined` for a refusal so the caller can REPORT it rather than
 * silently continuing to the well-known paths as if no pointer existed.
 */
export function resolveSameOriginPointer(
  pointer: string,
  enteredUrl: string,
): string | undefined {
  let resolved: URL;
  let base: URL;
  try {
    base = new URL(enteredUrl);
    resolved = new URL(pointer, enteredUrl);
  } catch {
    return undefined;
  }
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
    return undefined;
  }
  if (resolved.origin !== base.origin) return undefined;
  return resolved.toString();
}

/**
 * What one candidate produced: the document, or why it did not count.
 * `answered` is false when no HTTP answer arrived at all.
 */
export type MetadataCandidateResult<D> =
  | { document: D }
  | { error?: string; answered?: boolean };

export type MetadataLookup<C, D> =
  | { found: true; candidate: C; document: D }
  | {
      found: false;
      /** The last candidate's reason, which is what a report names. */
      lastError?: string;
      /** Whether any candidate got an HTTP answer. */
      answered: boolean;
    };

/**
 * Try `candidates` in order and stop at the first that yields a document.
 *
 * The caller's `fetchCandidate` decides what counts as a document and owns
 * the transport. A rejection from it propagates: a caller that wants a fatal
 * status to end discovery throws, and one that wants to keep going returns
 * an `error` instead.
 */
export async function findMetadataDocument<C, D>(
  candidates: readonly C[],
  fetchCandidate: (candidate: C) => Promise<MetadataCandidateResult<D>>
): Promise<MetadataLookup<C, D>> {
  let lastError: string | undefined;
  let answered = false;
  for (const candidate of candidates) {
    const result = await fetchCandidate(candidate);
    if ("document" in result) {
      return { found: true, candidate, document: result.document };
    }
    lastError = result.error;
    answered ||= result.answered !== false;
  }
  return { found: false, lastError, answered };
}
