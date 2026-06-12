import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import {
  getModelById,
  isBedrockModelId,
  isMCPJamProvidedModel,
  type ModelDefinition,
  type ModelProvider,
} from "@/shared/types";
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
  | { organizationId: string };

export type ResolveOrgProviderRuntimeTarget = { projectId: string };

export type ResolveOrgModelConfigAuth = {
  authHeader?: string;
  bearerToken?: string;
  /**
   * Chatbox identity is `chatboxId` + `accessVersion`. The cache key hashes
   * these so a link-token rotation does not invalidate model-config cache
   * entries, while an `accessVersion` bump (mode change, revoke, allowlist
   * edit) does.
   */
  chatboxId?: string;
  accessVersion?: number;
  serverIds?: string[];
};

// ---------------------------------------------------------------------------
// Local-runtime eligibility
//
// Mirrors LOCAL_RUNTIME_PROVIDERS in convex/organizationModelProviders.ts.
// Used by the chat-v2 route to skip the /stream/org/resolve round-trip for
// providers that can never run locally — those always go through the cloud
// path, so paying for a runtime-resolution call (and inheriting its failure
// modes) on every turn is pure overhead and a regression for the cloud path.
// ---------------------------------------------------------------------------

const LOCAL_RUNTIME_ELIGIBLE_PROVIDERS = new Set(["ollama"]);

export function isLocalRuntimeEligible(providerKey: string): boolean {
  return (
    LOCAL_RUNTIME_ELIGIBLE_PROVIDERS.has(providerKey) ||
    providerKey.startsWith("custom:")
  );
}

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

function formatTargetForCache(
  params: ResolveOrgModelConfigTarget | ResolveOrgProviderRuntimeTarget,
): string {
  return "projectId" in params
    ? `project:${params.projectId}`
    : `org:${params.organizationId}`;
}

function buildCacheKey(
  params: ResolveOrgModelConfigTarget,
  auth: ResolveOrgModelConfigAuth | undefined,
): string {
  const target = formatTargetForCache(params);
  // Cache key hashes (chatboxId, accessVersion) so a link-token rotation
  // doesn't invalidate cache entries while an accessVersion bump (mode
  // change, revoke, allowlist edit) does.
  const authHash = createHash("sha256")
    .update(
      JSON.stringify({
        authorization: normalizeAuthHeader(auth) ?? "",
        chatboxId: auth?.chatboxId?.trim() ?? "",
        accessVersion:
          auth?.chatboxId && auth.chatboxId.trim() &&
          Number.isFinite(auth?.accessVersion)
            ? auth.accessVersion
            : null,
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
        ...(auth?.chatboxId?.trim()
          ? { chatboxId: auth.chatboxId.trim() }
          : {}),
        ...(auth?.chatboxId?.trim() && Number.isFinite(auth?.accessVersion)
          ? { accessVersion: auth.accessVersion }
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

    const data = (await response.json()) as {
      ok?: boolean;
      error?: string;
      providers?: ResolvedProviderConfig[];
    };
    if (!data?.ok) {
      throw new Error(data?.error ?? "Failed to resolve org model config");
    }

    let providers = data.providers ?? [];
    // Hosted mode: drop org-supplied Bedrock endpoints that point at
    // private/internal address space before they are cached and handed to
    // the AI SDK. Uses the DNS-aware guard so a public hostname resolving
    // to a private IP (DNS rebinding) is rejected too — mirrors the check
    // the local-runtime path applies in resolveOrgProviderRuntime. Only the
    // offending provider is dropped (its own requests then fail with a
    // clear missing-config error) so one bad endpoint can't block every
    // other provider in the org config.
    if (HOSTED_MODE) {
      const safeProviders: ResolvedProviderConfig[] = [];
      for (const provider of providers) {
        if (
          provider.providerKey === "bedrock" &&
          typeof provider.baseUrl === "string" &&
          provider.baseUrl.length > 0
        ) {
          try {
            await assertSafeHostedOutboundUrl(provider.baseUrl);
          } catch (error) {
            console.warn(
              "[org-model-config] Dropping bedrock provider with blocked baseUrl:",
              error instanceof Error ? error.message : String(error),
            );
            continue;
          }
        }
        safeProviders.push(provider);
      }
      providers = safeProviders;
    }

    const result: ResolvedOrgModelConfig = { providers };
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

    if (provider.providerKey === "bedrock" && provider.baseUrl) {
      // Hosted mode: don't promote a baseUrl that points at private/internal
      // address space — eval-runner egress would otherwise follow it. Mirrors
      // the guard the local-runtime path applies in resolveOrgProviderRuntime.
      if (HOSTED_MODE && isUnsafeHostedOutboundUrl(provider.baseUrl)) {
        continue;
      }
      runtime.baseUrls.bedrock = provider.baseUrl;
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
    // fe80::/10 = fe80:: – febf:ffff:... (top 10 bits 1111 1110 10)
    // covers fe8x, fe9x, feax, febx — note fe80: alone misses fe81:–fe8f:
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
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
    // IPv6 addresses need brackets in URLs: http://[::1] not http://::1
    const testUrl = ip.includes(":") ? `http://[${ip}]` : `http://${ip}`;
    if (isUnsafeHostedOutboundUrl(testUrl)) {
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
  target: ResolveOrgProviderRuntimeTarget,
  providerKey: string,
  model: string,
  auth: ResolveOrgModelConfigAuth | undefined,
): string {
  const authHash = createHash("sha256")
    .update(
      JSON.stringify({
        authorization: normalizeAuthHeader(auth) ?? "",
        chatboxId: auth?.chatboxId?.trim() ?? "",
        accessVersion:
          auth?.chatboxId && auth.chatboxId.trim() &&
          Number.isFinite(auth?.accessVersion)
            ? auth.accessVersion
            : null,
        serverIds: normalizeServerIds(auth?.serverIds),
      }),
    )
    .digest("hex");
  return `runtime:${formatTargetForCache(target)}:${providerKey}:${model}:auth:${authHash}`;
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
  return resolveOrgProviderRuntimeForTarget(
    { projectId },
    providerKey,
    model,
    auth,
  );
}

export async function resolveOrgProviderRuntimeForTarget(
  target: ResolveOrgProviderRuntimeTarget,
  providerKey: string,
  model: string,
  auth?: ResolveOrgModelConfigAuth,
): Promise<OrgProviderRuntime> {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) throw new Error("CONVEX_HTTP_URL is not set");

  const cacheKey = buildRuntimeCacheKey(target, providerKey, model, auth);
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
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({
        ...target,
        providerKey,
        model,
        ...(auth?.chatboxId?.trim()
          ? { chatboxId: auth.chatboxId.trim() }
          : {}),
        ...(auth?.chatboxId?.trim() && Number.isFinite(auth?.accessVersion)
          ? { accessVersion: auth.accessVersion }
          : {}),
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

    const data = (await response.json()) as {
      ok?: boolean;
      error?: string;
      runtimeLocation?: string;
      provider?: unknown;
      providerKey?: unknown;
    };
    if (!data?.ok) {
      throw new Error(data?.error ?? "Failed to resolve org provider runtime");
    }

    if (data.runtimeLocation === "local") {
      const rawProvider = data.provider as
        | Partial<OrgProviderResolvedConfig>
        | undefined;
      if (
        !rawProvider ||
        typeof rawProvider.providerKey !== "string" ||
        rawProvider.providerKey.length === 0
      ) {
        throw new Error(
          "Org runtime resolve returned invalid local provider config",
        );
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
        typeof data.providerKey === "string" &&
        data.providerKey.trim().length > 0
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

// ---------------------------------------------------------------------------
// Synthetic model-source classification — single source of truth for the
// three-way MCPJam / cloud-BYOK / local-BYOK decision the synthetic runner
// makes per session.
// ---------------------------------------------------------------------------

/** Persisted attribution label on chatSessions / llmUsageRecord rows. */
export type SyntheticModelSource = "mcpjam" | "byok" | "local_byok";

/**
 * Result of {@link resolveSyntheticModelSource}.
 *
 * `orgRuntime` is present when `source !== "mcpjam"` so the synthetic
 * dispatcher can reuse the resolved runtime (cloud providerKey OR local
 * `OrgProviderResolvedConfig`) for the actual handler call — no
 * duplicate `resolveOrgProviderRuntime` round-trip.
 */
export interface SyntheticModelResolution {
  source: SyntheticModelSource;
  orgRuntime?: OrgProviderRuntime;
}

/**
 * Single source of truth for "what model-source class is this chatbox?"
 * Mirrors the three-way split the chat path does in `web-chat-turn.ts`,
 * narrowed to the surfaces synthetic can target (no user-API-key direct).
 *
 * Two callers in this PR:
 *   1. `drainAssistantTurn` (turn dispatch) — uses both `source` and
 *      `orgRuntime` to pick the handler.
 *   2. The empty-session fallback persist — uses `source` only for
 *      attribution.
 *
 * Pre-extraction, both encoded the same chain inline; this helper keeps
 * them aligned so adding a runtime location (or changing
 * `isLocalRuntimeEligible`'s allow-list) updates both call sites at once.
 *
 * Throws on `deriveOrgProviderKey` failure. Callers that need a soft
 * fallback (empty-session attribution) should wrap in try/catch and
 * default to `"byok"` — the failure means the real turns would have
 * failed too; we're best-effort labeling a row that exists only because
 * the run ended before any turn completed.
 */
export async function resolveSyntheticModelSource(args: {
  modelDefinition: ModelDefinition;
  projectId: string;
  authHeader?: string;
  chatboxId?: string;
  accessVersion?: number;
  serverIds?: string[];
}): Promise<SyntheticModelResolution> {
  const modelIdStr = String(args.modelDefinition.id);
  if (isMCPJamProvidedModel(modelIdStr)) {
    return { source: "mcpjam" };
  }
  const keyResult = deriveOrgProviderKey(args.modelDefinition);
  if (!keyResult.ok) {
    throw new Error(
      `Synthetic dispatch failed to derive org provider key: ${keyResult.error}`,
    );
  }
  const orgRuntime: OrgProviderRuntime = isLocalRuntimeEligible(keyResult.key)
    ? await resolveOrgProviderRuntime(
        args.projectId,
        keyResult.key,
        modelIdStr,
        {
          authHeader: args.authHeader,
          chatboxId: args.chatboxId,
          accessVersion: args.accessVersion,
          serverIds: args.serverIds,
        },
      )
    : { runtimeLocation: "cloud", providerKey: keyResult.key };
  return {
    source: orgRuntime.runtimeLocation === "local" ? "local_byok" : "byok",
    orgRuntime,
  };
}

// ---------------------------------------------------------------------------
// Synthetic model-definition builder — used by the synthetic runner when
// the chatbox is on a BYOK model that isn't in the static SUPPORTED_MODELS
// catalog (Ollama BYOK, custom: providers, OpenRouter-style ids, etc.).
// ---------------------------------------------------------------------------

/**
 * Map a model-id prefix to a ModelProvider. The catalog uses
 * provider/model ids where the prefix is the canonical provider name
 * with one quirk: `meta-llama/...` lives under provider `meta`, and
 * `x-ai/...` lives under provider `xai`. Mirrors the catalog entries in
 * `shared/types.ts::SUPPORTED_MODELS`.
 */
const ID_PREFIX_TO_PROVIDER: Record<string, ModelProvider> = {
  anthropic: "anthropic",
  azure: "azure",
  bedrock: "bedrock",
  deepseek: "deepseek",
  google: "google",
  "meta-llama": "meta",
  minimax: "minimax",
  moonshotai: "moonshotai",
  openai: "openai",
  ollama: "ollama",
  openrouter: "openrouter",
  qwen: "qwen",
  mistral: "mistral",
  "x-ai": "xai",
  "z-ai": "z-ai",
};

/**
 * Build a `ModelDefinition` from a bare modelId string (e.g. the value
 * `runtime.config.modelId` returns from `fetchChatboxRuntimeConfig`).
 *
 * Resolution order:
 *   1. `getModelById(modelId)` — MCPJam catalog hit returns the full
 *      definition unchanged (correct provider, contextLength, etc.).
 *   2. `custom:` prefix — provider="custom", customProviderName is the
 *      segment after `custom:` up to the first `:` or `/` (the picker
 *      mints `custom:<slug>:<modelId>`). Matches the
 *      `deriveOrgProviderKey` shape for custom providers.
 *   3. Known catalog-prefix shape (`anthropic/...`, `meta-llama/...`,
 *      `ollama/...`, etc.) — provider is derived from the prefix via
 *      ID_PREFIX_TO_PROVIDER.
 *   4. Bedrock-shaped bare id (`[geo.]vendor.name...:N`) — provider
 *      "bedrock". Org Bedrock models surface bare inference-profile ids
 *      in the picker, so chatbox runtime configs store them unprefixed.
 *   5. Bare id with no recognized shape — fall back to "ollama" since
 *      bare ids are how Ollama BYOK models are typically stored on
 *      chatbox runtime configs (no catalog ID uses a bare shape).
 *
 * Callers: the synthetic session runner (which only has
 * `runtime.config.modelId` — the chatbox runtime endpoint doesn't expose
 * provider today) and the chat routes' host-wins merges, where the host
 * config likewise pins a bare modelId and the provider must come from the
 * id shape, never from the request body's model.
 */
export function buildSyntheticModelDefinition(
  modelId: string,
): ModelDefinition {
  const supported = getModelById(modelId);
  if (supported) return supported;

  if (modelId.startsWith("custom:")) {
    const rest = modelId.slice("custom:".length);
    // Picker-minted ids are `custom:<slug>:<modelId>` (both the local and
    // org builders in model-helpers use a colon; the evals runner parses
    // the same way); tolerate `custom:<slug>/<modelId>` too. The slug is
    // the segment before the first `:` or `/`.
    const customProviderName = rest.split(/[:/]/, 1)[0];
    return {
      id: modelId,
      name: modelId,
      provider: "custom",
      customProviderName: customProviderName || undefined,
    };
  }

  const slashIdx = modelId.indexOf("/");
  if (slashIdx > 0) {
    const prefix = modelId.slice(0, slashIdx);
    const provider = ID_PREFIX_TO_PROVIDER[prefix];
    if (provider) {
      return {
        id: modelId,
        name: modelId,
        provider,
      };
    }
  }

  if (isBedrockModelId(modelId)) {
    return {
      id: modelId,
      name: modelId,
      provider: "bedrock",
    };
  }

  // Bare id (no `/`, not Bedrock-shaped) — Ollama BYOK is the remaining
  // realistic case since no catalog id is bare. If the org has a different
  // bare-id provider in the future, deriveOrgProviderKey will produce
  // "ollama" and the resolver round-trip will fail with a clearer error
  // than the previously-fatal catalog-miss path.
  return {
    id: modelId,
    name: modelId,
    provider: "ollama",
  };
}

// ---------------------------------------------------------------------------
// Host-pinned model lift (org-config-aware)
// ---------------------------------------------------------------------------

/**
 * Find the org provider whose per-provider model list explicitly contains
 * `modelId`, and build the definition from that provider. Mirrors the
 * client's `isOrgManagedModel` matching: openrouter/bedrock list ids in
 * `selectedModels`; ollama and `custom:<slug>` providers list them in
 * `modelIds` (custom ids are compared with the `custom:<slug>:` prefix
 * stripped). Returns null when no provider lists the id.
 */
export function matchOrgProviderForModelId(
  config: ResolvedOrgModelConfig,
  modelId: string,
): ModelDefinition | null {
  for (const p of config.providers) {
    if (p.providerKey === "openrouter" || p.providerKey === "bedrock") {
      if (p.selectedModels?.includes(modelId)) {
        return { id: modelId, name: modelId, provider: p.providerKey };
      }
    } else if (p.providerKey === "ollama") {
      if (p.modelIds?.includes(modelId)) {
        return { id: modelId, name: modelId, provider: "ollama" };
      }
    } else if (p.providerKey.startsWith("custom:")) {
      const slug = p.providerKey.slice("custom:".length);
      const prefix = `custom:${slug}:`;
      const bareId = modelId.startsWith(prefix)
        ? modelId.slice(prefix.length)
        : modelId;
      if (p.modelIds?.includes(bareId)) {
        return {
          id: modelId,
          name: modelId,
          provider: "custom",
          customProviderName: slug,
        };
      }
    }
  }
  return null;
}

/**
 * Lift a host-pinned bare modelId to a `ModelDefinition`, preferring the
 * org's provider config over id-shape inference. A non-catalog id like
 * `vendor/model` is intrinsically ambiguous — org OpenRouter selected
 * models keep their vendor-prefixed ids but belong to providerKey
 * "openrouter", while `buildSyntheticModelDefinition` would infer the
 * native vendor from the prefix. When an enabled provider explicitly
 * lists the id, that provider wins; shape inference is the fallback.
 *
 * `custom:`-prefixed and Bedrock-shaped ids skip the config fetch — their
 * shape is exact, and this path sits on a live chat turn.
 */
export async function resolveHostModelDefinition(args: {
  modelId: string;
  projectId?: string | null;
  auth?: ResolveOrgModelConfigAuth;
}): Promise<ModelDefinition> {
  const { modelId, projectId, auth } = args;

  const catalogHit = getModelById(modelId);
  if (catalogHit) return catalogHit;

  const shapeIsExact =
    modelId.startsWith("custom:") || isBedrockModelId(modelId);
  if (!shapeIsExact && projectId) {
    try {
      const config = await resolveOrgModelConfig({ projectId }, auth);
      const fromConfig = matchOrgProviderForModelId(config, modelId);
      if (fromConfig) return fromConfig;
    } catch {
      // Org config unavailable — fall through to shape inference, the
      // same best-effort behavior the synthetic runner has always had.
    }
  }

  return buildSyntheticModelDefinition(modelId);
}
