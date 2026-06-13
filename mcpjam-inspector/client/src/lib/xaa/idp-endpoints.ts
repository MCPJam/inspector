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
 * authorization server. Same base path the bootstrap dialog and the flow
 * runner use, so the issuer/JWKS values stay consistent across surfaces.
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
