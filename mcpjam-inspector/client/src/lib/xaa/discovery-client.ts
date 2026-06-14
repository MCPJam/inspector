import { HOSTED_MODE } from "@/lib/config";
import { authFetch } from "@/lib/session-token";
import type { NegativeTestDiff } from "@/shared/xaa.js";

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

export interface HealthCheckResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  durationMs: number;
  reason?: "timeout" | "unreachable" | "redirect_not_followed";
}

/**
 * Probe a registered health-check URL via the inspector server (which
 * validates the outbound URL). Throws with the server's message when the URL
 * itself is rejected; an unreachable or timed-out target resolves with
 * `ok: false` instead.
 */
export async function checkResourceHealth(
  url: string
): Promise<HealthCheckResult> {
  const response = await authFetch(`${XAA_API_BASE}/health-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

  const body = (await response.json().catch(() => null)) as
    | (HealthCheckResult & { message?: string })
    | null;

  if (!response.ok || !body) {
    throw new Error(
      body?.message || `Health check failed (${response.status})`
    );
  }

  return body;
}

export interface NegativeTestCase {
  mode: string;
  label: string;
  expectedFailure: string;
  outcome: "rejected" | "accepted" | "timeout" | "error";
  verdict: "pass" | "fail" | "unknown";
  status?: number;
  detail?: string;
  diff?: NegativeTestDiff;
}

export interface NegativeTestsResult {
  results: NegativeTestCase[];
  failures: number;
}

export interface NegativeTestsInput {
  audience: string;
  resource: string;
  subject?: string;
  clientId?: string;
  scope?: string;
  tokenEndpoint?: string;
  clientSecret?: string;
  registrationId?: string;
}

/**
 * Fire every deliberately-broken ID-JAG mode at the configured authorization
 * server and report, per case, whether it correctly rejected the assertion.
 * Registration-backed runs send only the registration id; the server resolves
 * the stored secret and endpoint.
 */
export async function runNegativeTests(
  input: NegativeTestsInput
): Promise<NegativeTestsResult> {
  const response = await authFetch(`${XAA_API_BASE}/negative-tests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  const body = (await response.json().catch(() => null)) as
    | (NegativeTestsResult & { message?: string })
    | null;

  if (!response.ok || !body) {
    throw new Error(
      body?.message || `Negative tests failed (${response.status})`
    );
  }

  return body;
}
