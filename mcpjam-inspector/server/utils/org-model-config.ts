import { createHash } from "node:crypto";
import type { ModelDefinition } from "@/shared/types";
import type { OrgProviderResolvedConfig } from "@mcpjam/sdk/model-factory";
import type { BaseUrls, CustomProviderConfig } from "./chat-helpers";

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

  const now = Date.now();
  pruneRuntimeResolveCache(now);
  runtimeResolveCache.set(cacheKey, {
    result,
    expiresAt: now + RUNTIME_CACHE_TTL_MS,
  });
  return result;
}
