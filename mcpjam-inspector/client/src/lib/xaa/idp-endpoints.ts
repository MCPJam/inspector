import { HOSTED_MODE } from "@/lib/config";
import { MCPJAM_HOSTED_APP_ORIGIN } from "@/lib/oauth/constants";

export interface XaaIdpUrls {
  issuerBaseUrl: string;
  openidConfigUrl: string;
  jwksUrl: string;
}

function getIssuerBasePath(): string {
  return HOSTED_MODE ? "/api/web/xaa" : "/api/mcp/xaa";
}

/**
 * Org-scoped issuer path segment, e.g. `/o/<orgId>`. Hosted-only: the local
 * router has no org concept, so a missing org (or local mode) yields "" and
 * every caller falls back to the unscoped issuer. Signed-in hosted users
 * should always prefer the scoped issuer — minting under it is gated on org
 * membership, unlike the legacy unscoped issuer.
 */
export function getOrgScopedIssuerSegment(
  organizationId?: string | null,
): string {
  return HOSTED_MODE && organizationId ? `/o/${organizationId}` : "";
}

/**
 * The hosted issuer a LOCAL run advertises when the "Use hosted issuer"
 * opt-in is on: minting is forwarded server-to-server to app.mcpjam.com, so
 * the token's `iss` (and the JWKS a remote AS fetches) live on the hosted
 * origin regardless of this build's mode. Signed-in users mint under their
 * org-scoped issuer; without an org the legacy unscoped issuer applies.
 * These URLs are constructed, not fetched — hosted CORS blocks a local
 * browser from reading the hosted discovery doc directly.
 */
export function getHostedXaaIdpUrls(organizationId?: string | null): XaaIdpUrls {
  const issuerBaseUrl = `${MCPJAM_HOSTED_APP_ORIGIN}/api/web/xaa${
    organizationId ? `/o/${organizationId}` : ""
  }`;
  return {
    issuerBaseUrl,
    openidConfigUrl: `${issuerBaseUrl}/.well-known/openid-configuration`,
    jwksUrl: `${issuerBaseUrl}/.well-known/jwks.json`,
  };
}

/**
 * Resolve the MCPJam-as-IdP endpoints the user pastes into their own
 * authorization server, derived from the browser origin. This is a synchronous
 * best-effort guess used for the initial render and as a fallback — in local
 * dev the browser origin (the Vite dev server) differs from the backend origin
 * that actually mints the ID-JAG `iss`, so prefer `fetchXaaIdpUrls` when an
 * accurate value matters (registration, issuer-trust comparisons).
 */
export function getXaaIdpUrls(organizationId?: string | null): XaaIdpUrls {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const issuerBaseUrl = `${origin}${getIssuerBasePath()}${getOrgScopedIssuerSegment(organizationId)}`;
  return {
    issuerBaseUrl,
    openidConfigUrl: `${issuerBaseUrl}/.well-known/openid-configuration`,
    jwksUrl: `${issuerBaseUrl}/.well-known/jwks.json`,
  };
}

/**
 * Resolve the IdP endpoints from the server's own OpenID configuration. The
 * server computes its `issuer` from the request it receives, so this reflects
 * the exact value stamped into the ID-JAG `iss` — including the right port and
 * scheme even when the browser reaches the API through the Vite dev proxy
 * (browser on :5173, backend on :6274). Falls back to null on any failure;
 * callers should default to `getXaaIdpUrls()` then.
 */
export async function fetchXaaIdpUrls(
  signal?: AbortSignal,
  organizationId?: string | null,
): Promise<XaaIdpUrls | null> {
  const { openidConfigUrl } = getXaaIdpUrls(organizationId);
  try {
    const response = await fetch(openidConfigUrl, { signal });
    if (!response.ok) {
      return null;
    }
    const config = (await response.json()) as {
      issuer?: unknown;
      jwks_uri?: unknown;
    };
    const issuer = typeof config.issuer === "string" ? config.issuer : null;
    if (!issuer) {
      return null;
    }
    const jwksUrl =
      typeof config.jwks_uri === "string"
        ? config.jwks_uri
        : `${issuer}/.well-known/jwks.json`;
    return {
      issuerBaseUrl: issuer,
      openidConfigUrl: `${issuer}/.well-known/openid-configuration`,
      jwksUrl,
    };
  } catch {
    return null;
  }
}
