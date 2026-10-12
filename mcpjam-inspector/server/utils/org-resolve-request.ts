/**
 * Request plumbing shared by the organization model config resolver
 * (`org-model-config.ts`) and the runtime resolver
 * (`org-runtime-admission.ts`), kept apart so neither imports the other.
 */
import dns from "node:dns/promises";
import { logger } from "./logger.js";
import { isUnsafeHostedOutboundUrl as isUnsafeHostedOutboundUrlLiteral } from "@/shared/local-only-mcp";
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
// In local-inspector mode (CLI/desktop) localhost and private IPs are the
// whole point of e.g. Ollama, so this check is gated by HOSTED_MODE.
// ---------------------------------------------------------------------------

export function isUnsafeHostedOutboundUrl(rawUrl: string): boolean {
  return isUnsafeHostedOutboundUrlLiteral(rawUrl);
}

/**
 * Async SSRF guard that also checks DNS resolution.
 *
 * `isUnsafeHostedOutboundUrl` only inspects the literal hostname; a public
 * hostname that resolves to a private/loopback/metadata IP bypasses it.
 * This function adds a DNS preflight so that any resolved IP is also checked.
 *
 * For IP-literal hosts the sync check is sufficient; DNS lookup is only
 * performed for hostnames, accepting a small TOCTOU window that would require
 * an attacker to control both the DNS record and its TTL.
 */
export async function assertSafeHostedOutboundUrl(
  rawUrl: string,
): Promise<void> {
  if (isUnsafeHostedOutboundUrl(rawUrl)) {
    throw new Error(
      `Provider base URL is blocked: points to a private or internal address`,
    );
  }
  // For non-IP-literal hostnames, also validate the DNS-resolved IPs.
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isIpLiteral = /^[\d.]+$/.test(host) || /^[0-9a-f:]+$/i.test(host);
  if (isIpLiteral) return;

  const resolvedIps: string[] = [];
  for (const resolve of [dns.resolve4, dns.resolve6]) {
    try {
      resolvedIps.push(...(await resolve(host)));
    } catch (error) {
      // One address family may be absent; the empty-address guard fails closed.
      logger.debug("Provider DNS lookup failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  if (resolvedIps.length === 0) {
    throw new Error(
      `Provider base URL is blocked: hostname "${host}" could not be resolved`,
    );
  }
  for (const ip of resolvedIps) {
    // IPv6 addresses need brackets in URLs: http://[::1] not http://::1
    const testUrl = ip.includes(":") ? `http://[${ip}]` : `http://${ip}`;
    if (isUnsafeHostedOutboundUrl(testUrl)) {
      throw new Error(
        `Provider base URL is blocked: hostname "${host}" resolves to a private or internal address`,
      );
    }
  }
}
