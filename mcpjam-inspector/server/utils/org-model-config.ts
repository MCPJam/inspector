import type { ModelDefinition } from "@/shared/types";

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

export async function resolveOrgModelConfig(
  params: { workspaceId: string } | { organizationId: string },
): Promise<ResolvedOrgModelConfig> {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }

  const inspectorServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!inspectorServiceToken) {
    throw new Error("INSPECTOR_SERVICE_TOKEN is not set");
  }

  const cacheKey =
    "workspaceId" in params ? `ws:${params.workspaceId}` : `org:${params.organizationId}`;
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
      },
      body: JSON.stringify(params),
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
    resolveCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
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
