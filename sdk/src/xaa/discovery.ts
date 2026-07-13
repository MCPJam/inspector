// Pure XAA discovery helpers — browser- and node-safe (string/URL only). The
// three well-known documents in an ID-JAG flow have DIFFERENT semantics, so
// they get separate, purpose-named builders rather than one opaque function:
//
//   - protected-resource metadata (RFC 9728) — names the authorization server
//     that protects a resource (the MCP server URL);
//   - authorization-server metadata (RFC 8414 + OIDC) — carries the token
//     endpoint and the AS's canonical issuer;
//   - issuer-publication metadata (OIDC) — the config whose `jwks_uri` lets a
//     self-issuing IdP confirm its own signing key is published.
//
// The ordered candidate lists preserve the CLI's existing sweep exactly, so the
// `run-xaa-flow` contract tests are the golden verification for these tables.

/**
 * Canonicalize an MCP server URL into the `resource` identifier: origin +
 * pathname + query, preserving a trailing slash and the query (both can
 * distinguish resources), with the origin normalized by `URL`.
 */
export function canonicalizeMcpResource(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return serverUrl;
  }
}

// Build the ordered `.well-known/<name>` candidates for an issuer/resource:
// path-insertion (preserving a trailing slash), path-append, then origin-root.
// A path-less input yields only the root form; an unparseable input degrades to
// a single best-effort root candidate.
function wellKnownCandidates(
  issuer: string,
  name: string,
  preserveQuery = false,
): string[] {
  let origin: string;
  let path: string;
  let query: string;
  try {
    const url = new URL(issuer);
    origin = url.origin;
    path = url.pathname === "/" ? "" : url.pathname;
    query = preserveQuery ? url.search : "";
  } catch {
    return [`${issuer.replace(/\/+$/, "")}/.well-known/${name}`];
  }
  if (!path) return [`${origin}/.well-known/${name}${query}`];

  const pathNoTrailing = path.replace(/\/+$/, "");
  return [
    ...new Set([
      `${origin}/.well-known/${name}${path}${query}`,
      `${origin}${pathNoTrailing}/.well-known/${name}${query}`,
      `${origin}/.well-known/${name}`,
    ]),
  ];
}

/** The AS-metadata document types, probed OAuth-first then OIDC. */
export const XAA_AS_METADATA_NAMES = [
  "oauth-authorization-server",
  "openid-configuration",
] as const;

/**
 * RFC 9728 protected-resource-metadata candidates for a resource (the MCP
 * server URL). PRM names the authorization server(s) protecting the resource.
 */
export function buildProtectedResourceMetadataCandidates(
  resource: string,
): string[] {
  return wellKnownCandidates(resource, "oauth-protected-resource", true);
}

/**
 * RFC 8414 / OIDC authorization-server-metadata candidates for an issuer, in
 * probe order: for each document type (OAuth AS, then OIDC), the insertion,
 * append, and root forms.
 */
export function buildAuthorizationServerMetadataCandidates(
  issuer: string,
): string[] {
  return XAA_AS_METADATA_NAMES.flatMap((name) =>
    wellKnownCandidates(issuer, name),
  );
}

/**
 * OIDC configuration candidates for an issuer, used to locate the `jwks_uri`
 * when verifying that a (self-)issuer actually publishes its signing key.
 */
export function buildIssuerPublicationCandidates(issuer: string): string[] {
  return wellKnownCandidates(issuer, "openid-configuration");
}
