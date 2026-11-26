/**
 * Request plumbing shared by the organization model config resolver
 * (`org-model-config.ts`) and the runtime resolver
 * (`org-runtime-admission.ts`), kept apart so neither imports the other.
 */
import {
  assertAllowedHostedTargetUrl,
  isBlockedEgressHost,
} from "./hosted-egress-guard.js";
import type {
  ResolveOrgModelConfigAuth,
  ResolveOrgModelConfigTarget,
  ResolveOrgProviderRuntimeTarget,
} from "./org-model-config.js";

export const RESOLVE_TIMEOUT_MS = 15_000;

export function normalizeAuthHeader(
  auth: ResolveOrgModelConfigAuth | undefined,
): string | undefined {
  const header = auth?.authHeader?.trim();
  if (header) return header;

  const bearerToken = auth?.bearerToken?.trim();
  if (!bearerToken) return undefined;
  return /^Bearer\s+/i.test(bearerToken)
    ? bearerToken
    : `Bearer ${bearerToken}`;
}

export function normalizeServerIds(serverIds: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (serverIds ?? [])
        .map((serverId) => serverId.trim())
        .filter((serverId) => serverId.length > 0),
    ),
  ).sort();
}

export function formatTargetForCache(
  params: ResolveOrgModelConfigTarget | ResolveOrgProviderRuntimeTarget,
): string {
  return "projectId" in params
    ? `project:${params.projectId}`
    : `org:${params.organizationId}`;
}

// ---------------------------------------------------------------------------
// Outbound URL safety
//
// Local-runtime providers return a baseUrl that the inspector then dials
// directly. In hosted mode the inspector backend sits on a shared/cloud
// network, so an org admin who points a custom provider at, e.g.,
// http://169.254.169.254/ or an internal hostname turns the inspector into
// an SSRF proxy against itself. Reject those baseUrls here, before the URL
// is cached or handed to the AI SDK provider builder.
//
// The verdict is the hosted egress guard's (`hosted-egress-guard.ts`), the
// same one MCP server URLs get, so the private destinations an operator lists
// in MCPJAM_PRIVATE_EGRESS_ALLOWLIST reach model endpoints too, and nothing
// else does.
//
// In local-inspector mode (CLI/desktop) localhost and private IPs are the
// whole point of e.g. Ollama, so callers gate these checks on HOSTED_MODE.
// ---------------------------------------------------------------------------

/** The guard's literal verdict, for a check that cannot wait on DNS. */
export function isUnsafeHostedOutboundUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return true;
  }
  return isBlockedEgressHost(parsed.hostname, true);
}

/**
 * The guard's full verdict: the literal host, then every address a hostname
 * resolves to, so a public name answering with a private address is refused
 * unless the operator listed it. For IP-literal hosts the literal check is the
 * whole answer; for names a small TOCTOU window remains between this lookup
 * and the provider client's own, which would need an attacker to control both
 * the DNS record and its TTL.
 */
export async function assertSafeHostedOutboundUrl(
  rawUrl: string,
): Promise<void> {
  await assertAllowedHostedTargetUrl(rawUrl, "Provider base URL", {
    hosted: true,
  });
}
