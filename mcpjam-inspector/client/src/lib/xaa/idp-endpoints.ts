import { HOSTED_MODE } from "@/lib/config";

export interface XaaIdpUrls {
  issuerBaseUrl: string;
  openidConfigUrl: string;
  jwksUrl: string;
}

function getIssuerBasePath(): string {
  return HOSTED_MODE ? "/api/web/xaa" : "/api/mcp/xaa";
}

/**
 * Resolve the MCPJam-as-IdP endpoints the user pastes into their own
 * authorization server, derived from the browser origin. This is a synchronous
 * best-effort guess used for the initial render and as a fallback — in local
 * dev the browser origin (the Vite dev server) differs from the backend origin
 * that actually mints the ID-JAG `iss`, so prefer `fetchXaaIdpUrls` when an
 * accurate value matters (registration, issuer-trust comparisons).
 */
export function getXaaIdpUrls(): XaaIdpUrls {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const issuerBaseUrl = `${origin}${getIssuerBasePath()}`;
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
): Promise<XaaIdpUrls | null> {
  const { openidConfigUrl } = getXaaIdpUrls();
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

interface JwksResponse {
  keys?: Array<{ kid?: unknown }>;
}

/**
 * Best-effort fetch of the active signing key id from the JWKS endpoint.
 * Returns null on any failure — the kid is a convenience for the user
 * configuring issuer trust, not required for the card to render.
 */
export async function fetchActiveKeyId(
  jwksUrl: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetch(jwksUrl, { signal });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as JwksResponse;
    const kid = body.keys?.[0]?.kid;
    return typeof kid === "string" && kid.length > 0 ? kid : null;
  } catch {
    return null;
  }
}
