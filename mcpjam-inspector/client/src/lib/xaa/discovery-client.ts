import { HOSTED_MODE } from "@/lib/config";
import { authFetch } from "@/lib/session-token";

const XAA_API_BASE = HOSTED_MODE ? "/api/web/xaa" : "/api/mcp/xaa";

export interface AsDiscoveryResult {
  issuer?: string;
  tokenEndpoint?: string;
  grantTypesSupported?: string[];
  jwtBearerSupport: "pass" | "warn" | "fail";
  jwtBearerDetail: string;
  hasTokenEndpoint: boolean;
  issuerMismatch: {
    requested: string;
    advertised: string;
    schemeOnly: boolean;
  } | null;
  metadataUrl: string;
}

/**
 * Probe an authorization server's metadata via the inspector server's
 * discovery endpoint (which validates outbound URLs and tries both
 * well-known forms). Throws with the server's message on failure.
 */
export async function discoverAuthorizationServer(input: {
  issuer?: string;
  tokenEndpoint?: string;
}): Promise<AsDiscoveryResult> {
  const response = await authFetch(`${XAA_API_BASE}/discover-as`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  const body = (await response.json().catch(() => null)) as
    | (AsDiscoveryResult & { message?: string })
    | null;

  if (!response.ok || !body) {
    throw new Error(body?.message || `Discovery failed (${response.status})`);
  }

  return body;
}
