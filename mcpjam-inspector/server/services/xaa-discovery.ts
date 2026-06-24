// Server-side authorization-server discovery helpers for the XAA test bench.
// Pure functions (candidate URL construction + metadata verdicts) live here so
// they can be unit-tested without a live authorization server; the route layer
// in routes/mcp/xaa.ts wires them to the SSRF-guarded fetcher.

export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

const OIDC_SUFFIX = "/.well-known/openid-configuration";
const OAUTH_AS_SUFFIX = "/.well-known/oauth-authorization-server";

function stripTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Build the ordered list of well-known metadata URLs to probe for an issuer
 * (or token endpoint). Covers both forms so path-based issuers (Auth0 custom
 * domains, Keycloak realms) and root issuers both resolve:
 *   - RFC 8414 / OIDC path-insertion: origin + /.well-known/... + path
 *   - root-append:                    issuer + /.well-known/openid-configuration
 *   - pure root:                      origin + /.well-known/openid-configuration
 *
 * If the input already points at a well-known document, it's used verbatim.
 */
export function buildDiscoveryCandidates(input: string): string[] {
  const url = new URL(input);

  const path = stripTrailingSlash(url.pathname);
  if (path.endsWith(OIDC_SUFFIX) || path.endsWith(OAUTH_AS_SUFFIX)) {
    return [url.toString()];
  }

  const origin = url.origin;
  const candidates: string[] = [];

  if (path && path !== "") {
    // Path-insertion forms (well-known segment inserted before the issuer path)
    candidates.push(`${origin}${OIDC_SUFFIX}${path}`);
    candidates.push(`${origin}${OAUTH_AS_SUFFIX}${path}`);
    // Root-append form (well-known segment appended after the issuer path)
    candidates.push(`${origin}${path}${OIDC_SUFFIX}`);
  } else {
    candidates.push(`${origin}${OIDC_SUFFIX}`);
    candidates.push(`${origin}${OAUTH_AS_SUFFIX}`);
  }

  // Pure-root fallback regardless of path.
  candidates.push(`${origin}${OIDC_SUFFIX}`);

  return Array.from(new Set(candidates));
}

const PRM_SUFFIX = "/.well-known/oauth-protected-resource";

/**
 * Build the ordered list of RFC 9728 protected-resource-metadata (PRM) URLs to
 * probe for a resource (the MCP server URL). PRM is the document that names the
 * authorization server(s) protecting the resource — the issuer is NOT the
 * resource URL itself, so we read it from here rather than guessing.
 *
 * RFC 9728 §3.1 inserts the well-known segment between the host and the
 * resource's path (`https://host/mcp` → `https://host/.well-known/oauth-protected-resource/mcp`);
 * the path-less root form is the fallback some servers serve at the origin.
 */
export function buildResourceMetadataCandidates(input: string): string[] {
  const url = new URL(input);
  const origin = url.origin;
  const root = `${origin}${PRM_SUFFIX}`;

  const path = stripTrailingSlash(url.pathname);
  if (path && path !== "") {
    return Array.from(new Set([`${origin}${PRM_SUFFIX}${path}`, root]));
  }

  return [root];
}

function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the first usable authorization-server issuer out of an RFC 9728 PRM
 * document. Skips entries that aren't parseable URLs so a malformed entry
 * doesn't abort discovery when a later entry is valid. Returns undefined when
 * the document advertises none (e.g. the fetched URL wasn't actually PRM), so
 * callers can fall back to another discovery path.
 */
export function extractAuthorizationServer(
  metadata: Record<string, unknown>,
): string | undefined {
  const servers = metadata.authorization_servers;
  if (!Array.isArray(servers)) {
    return undefined;
  }
  for (const entry of servers) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed && isParseableUrl(trimmed)) {
      return trimmed;
    }
  }
  return undefined;
}

export type GrantSupportStatus = "pass" | "warn" | "fail";

export interface IssuerMismatch {
  requested: string;
  advertised: string;
  schemeOnly: boolean;
}

export interface DiscoveryVerdict {
  issuer?: string;
  tokenEndpoint?: string;
  grantTypesSupported?: string[];
  jwtBearerSupport: GrantSupportStatus;
  jwtBearerDetail: string;
  hasTokenEndpoint: boolean;
  issuerMismatch: IssuerMismatch | null;
  metadataUrl: string;
}

// Host + path, scheme excluded — used to detect a scheme-only mismatch
// (the http-issuer-behind-https-proxy bug) separately from a real host/path
// divergence.
function hostAndPath(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${stripTrailingSlash(url.pathname)}`;
  } catch {
    return stripTrailingSlash(value);
  }
}

// Full identity including scheme — two issuers are "the same" only when this
// matches.
function fullIdentity(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${stripTrailingSlash(url.pathname)}`;
  } catch {
    return stripTrailingSlash(value);
  }
}

/**
 * Turn fetched authorization-server metadata into the verdicts the runner
 * renders: jwt-bearer grant support (pass/warn/fail), token-endpoint presence,
 * and an issuer-mismatch flag (the classic http-issuer-behind-https-proxy bug).
 */
export function evaluateDiscovery(
  metadata: Record<string, unknown>,
  context: { requestedIssuer: string; metadataUrl: string },
): DiscoveryVerdict {
  const issuer =
    typeof metadata.issuer === "string" ? metadata.issuer : undefined;
  const tokenEndpoint =
    typeof metadata.token_endpoint === "string"
      ? metadata.token_endpoint
      : undefined;
  const grantTypesAdvertised = Array.isArray(metadata.grant_types_supported);
  const grantTypes = grantTypesAdvertised
    ? (metadata.grant_types_supported as unknown[]).filter(
        (g): g is string => typeof g === "string",
      )
    : undefined;

  let jwtBearerSupport: GrantSupportStatus;
  let jwtBearerDetail: string;
  if (grantTypes?.includes(JWT_BEARER_GRANT)) {
    jwtBearerSupport = "pass";
    jwtBearerDetail = "Advertised in grant_types_supported.";
  } else if (!grantTypesAdvertised) {
    jwtBearerSupport = "warn";
    jwtBearerDetail =
      "grant_types_supported is missing from discovery metadata. Support can't be verified without attempting the token exchange.";
  } else {
    jwtBearerSupport = "fail";
    jwtBearerDetail =
      grantTypes && grantTypes.length === 0
        ? "grant_types_supported is an empty array; the authorization server declares no supported grant types."
        : `grant_types_supported does not include ${JWT_BEARER_GRANT}.`;
  }

  let issuerMismatch: IssuerMismatch | null = null;
  if (
    issuer &&
    fullIdentity(issuer) !== fullIdentity(context.requestedIssuer)
  ) {
    issuerMismatch = {
      requested: context.requestedIssuer,
      advertised: issuer,
      // Same host/path, different scheme → almost always a proxy that
      // terminates TLS but advertises an http:// issuer.
      schemeOnly: hostAndPath(issuer) === hostAndPath(context.requestedIssuer),
    };
  }

  return {
    issuer,
    tokenEndpoint,
    grantTypesSupported: grantTypes,
    jwtBearerSupport,
    jwtBearerDetail,
    hasTokenEndpoint: Boolean(tokenEndpoint),
    issuerMismatch,
    metadataUrl: context.metadataUrl,
  };
}
