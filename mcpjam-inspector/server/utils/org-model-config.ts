import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import type { ModelDefinition } from "@/shared/types";
import type { OrgProviderResolvedConfig } from "@mcpjam/sdk/model-factory";
import type { BaseUrls, CustomProviderConfig } from "./chat-helpers";
import { HOSTED_MODE } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResolvedProviderConfig = {
  providerKey: string;
  apiKey?: string;
  baseUrl?: string;
  protocol?: string;
  modelIds?: string[];
  displayName?: string;
  selectedModels?: string[];
};

export type ResolvedOrgModelConfig = {
  providers: ResolvedProviderConfig[];
};

export type ResolveOrgModelConfigTarget =
  | { projectId: string }
  | { workspaceId: string }
  | { organizationId: string };

export type ResolveOrgModelConfigAuth = {
  authHeader?: string;
  bearerToken?: string;
  shareToken?: string;
  chatboxToken?: string;
  serverIds?: string[];
};

// ---------------------------------------------------------------------------
// Resolution — call the Convex HTTP endpoint
// ---------------------------------------------------------------------------

const INSPECTOR_SERVICE_TOKEN_HEADER = "X-Inspector-Service-Token";
const RESOLVE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// In-process cache — avoids one 15 s HTTP call per eval test case.
// TTL is intentionally short so key rotations propagate within a minute.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
const resolveCache = new Map<
  string,
  { result: ResolvedOrgModelConfig; expiresAt: number }
>();

function normalizeAuthHeader(
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

function normalizeServerIds(serverIds: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (serverIds ?? [])
        .map((serverId) => serverId.trim())
        .filter((serverId) => serverId.length > 0),
    ),
  ).sort();
}

function buildCacheKey(
  params: ResolveOrgModelConfigTarget,
  auth: ResolveOrgModelConfigAuth | undefined,
): string {
  const target = "projectId" in params
    ? `project:${params.projectId}`
    : "workspaceId" in params
    ? `legacy-workspace:${params.workspaceId}`
    : `org:${params.organizationId}`;
  const authHash = createHash("sha256")
    .update(
      JSON.stringify({
        authorization: normalizeAuthHeader(auth) ?? "",
        shareToken: auth?.shareToken?.trim() ?? "",
        chatboxToken: auth?.chatboxToken?.trim() ?? "",
        serverIds: normalizeServerIds(auth?.serverIds),
      }),
    )
    .digest("hex");
  return `${target}:auth:${authHash}`;
}

export async function resolveOrgModelConfig(
  params: ResolveOrgModelConfigTarget,
  auth?: ResolveOrgModelConfigAuth,
): Promise<ResolvedOrgModelConfig> {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }

  const inspectorServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!inspectorServiceToken) {
    throw new Error("INSPECTOR_SERVICE_TOKEN is not set");
  }

  const authHeader = normalizeAuthHeader(auth);
  const serverIds = normalizeServerIds(auth?.serverIds);
  const cacheKey = buildCacheKey(params, auth);
  const cached = resolveCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const url = `${convexHttpUrl.replace(/\/$/, "")}/internal/v1/org-model-config/resolve`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INSPECTOR_SERVICE_TOKEN_HEADER]: inspectorServiceToken,
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({
        ...params,
        ...(auth?.shareToken?.trim()
          ? { shareToken: auth.shareToken.trim() }
          : {}),
        ...(auth?.chatboxToken?.trim()
          ? { chatboxToken: auth.chatboxToken.trim() }
          : {}),
        ...(serverIds.length > 0 ? { serverIds } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let message = `Org model config resolution failed (${response.status})`;
      try {
        const parsed = JSON.parse(body);
        if (parsed?.error) message = parsed.error;
      } catch {
        // ignore parse failure
      }
      throw new Error(message);
    }

    const data = await response.json();
    if (!data?.ok) {
      throw new Error(data?.error ?? "Failed to resolve org model config");
    }

    const result: ResolvedOrgModelConfig = { providers: data.providers ?? [] };
    resolveCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Map a ModelDefinition to the providerKey used by the org-managed
// model provider config. Custom providers prefix with "custom:<name>"
// to match convex/organizationModelProviders.ts's isCustomProviderKey.
// Returns a discriminated result so callers can wrap the error type they
// need (e.g. WebRouteError vs plain Error) without duplicating the logic.
// ---------------------------------------------------------------------------

export type DeriveOrgProviderKeyResult =
  | { ok: true; key: string }
  | { ok: false; error: string };

export function deriveOrgProviderKey(
  modelDefinition: ModelDefinition,
): DeriveOrgProviderKeyResult {
  if (modelDefinition.provider === "custom") {
    if (!modelDefinition.customProviderName) {
      return {
        ok: false,
        error: "Custom model is missing customProviderName",
      };
    }
    return { ok: true, key: `custom:${modelDefinition.customProviderName}` };
  }
  return { ok: true, key: modelDefinition.provider };
}

// ---------------------------------------------------------------------------
// Build modelApiKeys map (for eval routes)
// ---------------------------------------------------------------------------

export function buildModelApiKeysFromOrgConfig(
  config: ResolvedOrgModelConfig,
): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const p of config.providers) {
    if (!p.apiKey) continue;
    // The eval runner looks up keys by built-in provider name
    // (e.g. "openai", "anthropic"). Custom providers' API keys are
    // resolved separately through resolveProviderForModel's
    // customProviders array, so skip them here.
    if (p.providerKey.startsWith("custom:")) continue;
    keys[p.providerKey] = p.apiKey;
  }
  return keys;
}

export type OrgLlmRuntimeConfig = {
  modelApiKeys: Record<string, string>;
  baseUrls: BaseUrls;
  customProviders: CustomProviderConfig[];
};

export function buildLlmRuntimeConfigFromOrgConfig(
  config: ResolvedOrgModelConfig,
): OrgLlmRuntimeConfig {
  const runtime: OrgLlmRuntimeConfig = {
    modelApiKeys: buildModelApiKeysFromOrgConfig(config),
    baseUrls: {},
    customProviders: [],
  };

  for (const provider of config.providers) {
    if (provider.providerKey === "ollama" && provider.baseUrl) {
      runtime.baseUrls.ollama = provider.baseUrl;
      continue;
    }

    if (provider.providerKey === "azure" && provider.baseUrl) {
      runtime.baseUrls.azure = provider.baseUrl;
      continue;
    }

    if (
      provider.providerKey.startsWith("custom:") &&
      provider.baseUrl &&
      provider.modelIds
    ) {
      const name = provider.providerKey.replace(/^custom:/, "");
      if (!name) continue;

      runtime.customProviders.push({
        name,
        protocol: provider.protocol || "openai-compatible",
        baseUrl: provider.baseUrl,
        modelIds: provider.modelIds,
        ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      });
    }
  }

  return runtime;
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
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Fail closed: an unparseable baseUrl can't be used safely.
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return true;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;

  if (
    host === "localhost" ||
    host === "ip6-localhost" ||
    host === "ip6-loopback" ||
    host.endsWith(".localhost")
  ) {
    return true;
  }
  // Cloud metadata service hostnames.
  if (host === "metadata" || host === "metadata.google.internal") {
    return true;
  }

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map((n) => Number(n));
    if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = octets;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + AWS/Azure metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  if (host.includes(":")) {
    const lower = host;
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
      return true; // fe80::/10 link-local
    }
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
    // IPv4-mapped IPv6: ::ffff:a.b.c.d (rare in practice — most parsers
    // canonicalize to ::ffff:HHHH:HHHH).
    const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) return isUnsafeHostedOutboundUrl(`http://${dotted[1]}`);
    const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      if (
        Number.isFinite(high) &&
        Number.isFinite(low) &&
        high >= 0 &&
        high <= 0xffff &&
        low >= 0 &&
        low <= 0xffff
      ) {
        const a = (high >> 8) & 0xff;
        const b = high & 0xff;
        const c = (low >> 8) & 0xff;
        const d = low & 0xff;
        return isUnsafeHostedOutboundUrl(`http://${a}.${b}.${c}.${d}`);
      }
    }
    return false;
  }

  return false;
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
async function assertSafeHostedOutboundUrl(rawUrl: string): Promise<void> {
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
  try { resolvedIps.push(...await dns.resolve4(host)); } catch { /* NXDOMAIN etc */ }
  try { resolvedIps.push(...await dns.resolve6(host)); } catch {}
  if (resolvedIps.length === 0) {
    throw new Error(
      `Provider base URL is blocked: hostname "${host}" could not be resolved`,
    );
  }
  for (const ip of resolvedIps) {
    if (isUnsafeHostedOutboundUrl(`http://${ip}`)) {
      throw new Error(
        `Provider base URL is blocked: hostname "${host}" resolves to a private or internal address`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime resolver — calls /stream/org/resolve to determine whether the
// provider should execute in Convex (cloud) or directly in the inspector (local).
// ---------------------------------------------------------------------------

export type OrgProviderRuntimeCloud = {
  runtimeLocation: "cloud";
  providerKey: string;
};

export type OrgProviderRuntimeLocal = {
  runtimeLocation: "local";
  provider: OrgProviderResolvedConfig;
};

export type OrgProviderRuntime = OrgProviderRuntimeCloud | OrgProviderRuntimeLocal;

const RUNTIME_CACHE_TTL_MS = 60_000;
const RUNTIME_CACHE_MAX_ENTRIES = 1_000;
const runtimeResolveCache = new Map<
  string,
  { result: OrgProviderRuntime; expiresAt: number }
>();

function pruneRuntimeResolveCache(now: number): void {
  // Always evict expired entries — they may hold decrypted API keys.
  for (const [key, entry] of runtimeResolveCache) {
    if (entry.expiresAt <= now) runtimeResolveCache.delete(key);
  }
  // Then cap size by removing oldest entries if still over limit.
  if (runtimeResolveCache.size > RUNTIME_CACHE_MAX_ENTRIES) {
    const overflow = runtimeResolveCache.size - RUNTIME_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const key of runtimeResolveCache.keys()) {
      if (removed >= overflow) break;
      runtimeResolveCache.delete(key);
      removed++;
    }
  }
}

function buildRuntimeCacheKey(
  projectId: string,
  providerKey: string,
  model: string,
  auth: ResolveOrgModelConfigAuth | undefined,
): string {
  const authHash = createHash("sha256")
    .update(
      JSON.stringify({
        authorization: normalizeAuthHeader(auth) ?? "",
        shareToken: auth?.shareToken?.trim() ?? "",
        chatboxToken: auth?.chatboxToken?.trim() ?? "",
        serverIds: normalizeServerIds(auth?.serverIds),
      }),
    )
    .digest("hex");
  return `runtime:project:${projectId}:${providerKey}:${model}:auth:${authHash}`;
}

/**
 * Resolve the runtime location for a provider by calling /stream/org/resolve.
 *
 * Cloud: LLM executes in Convex — return the providerKey so the caller can
 *   route to handleHostedOrgChatModel as before.
 * Local: LLM executes in the inspector — return the full provider config
 *   (including apiKey) so the caller can build the model directly.
 *
 * Results are cached for 60 s so key rotations propagate within a minute
 * while repeated agentic-loop steps don't each pay the round-trip cost.
 */
export async function resolveOrgProviderRuntime(
  projectId: string,
  providerKey: string,
  model: string,
  auth?: ResolveOrgModelConfigAuth,
): Promise<OrgProviderRuntime> {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) throw new Error("CONVEX_HTTP_URL is not set");

  const inspectorServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!inspectorServiceToken) throw new Error("INSPECTOR_SERVICE_TOKEN is not set");

  const cacheKey = buildRuntimeCacheKey(projectId, providerKey, model, auth);
  const now = Date.now();
  pruneRuntimeResolveCache(now);
  const cached = runtimeResolveCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const authHeader = normalizeAuthHeader(auth);
  const serverIds = normalizeServerIds(auth?.serverIds);

  const url = `${convexHttpUrl.replace(/\/$/, "")}/stream/org/resolve`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

  let result: OrgProviderRuntime;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INSPECTOR_SERVICE_TOKEN_HEADER]: inspectorServiceToken,
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({
        projectId,
        providerKey,
        model,
        ...(auth?.shareToken?.trim() ? { shareToken: auth.shareToken.trim() } : {}),
        ...(auth?.chatboxToken?.trim() ? { chatboxToken: auth.chatboxToken.trim() } : {}),
        ...(serverIds.length > 0 ? { serverIds } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let message = `Org runtime resolution failed (${response.status})`;
      try {
        const parsed = JSON.parse(body);
        if (parsed?.error) message = parsed.error;
      } catch {
        // ignore
      }
      throw new Error(message);
    }

    const data = await response.json();
    if (!data?.ok) {
      throw new Error(data?.error ?? "Failed to resolve org provider runtime");
    }

    if (data.runtimeLocation === "local") {
      const rawProvider = data.provider;
      if (!rawProvider || typeof rawProvider.providerKey !== "string" || rawProvider.providerKey.length === 0) {
        throw new Error("Org runtime resolve returned invalid local provider config");
      }
      // SSRF guard: in hosted mode reject baseUrls that point to private,
      // loopback, link-local, or cloud-metadata addresses — including
      // public hostnames that DNS-resolve to such IPs (DNS rebinding).
      // In local-inspector mode (CLI/desktop) private IPs are legitimate.
      if (
        HOSTED_MODE &&
        typeof rawProvider.baseUrl === "string" &&
        rawProvider.baseUrl.length > 0
      ) {
        await assertSafeHostedOutboundUrl(rawProvider.baseUrl);
      }
      result = {
        runtimeLocation: "local",
        provider: rawProvider as OrgProviderResolvedConfig,
      };
    } else {
      const resolvedKey =
        typeof data.providerKey === "string" && data.providerKey.trim().length > 0
          ? data.providerKey
          : providerKey;
      result = {
        runtimeLocation: "cloud",
        providerKey: resolvedKey,
      };
    }
  } finally {
    clearTimeout(timeout);
  }

  const writeNow = Date.now();
  pruneRuntimeResolveCache(writeNow);
  runtimeResolveCache.set(cacheKey, {
    result,
    expiresAt: writeNow + RUNTIME_CACHE_TTL_MS,
  });
  return result;
}
