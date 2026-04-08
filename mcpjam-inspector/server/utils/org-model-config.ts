import type { ModelDefinition } from "@/shared/types";
import type { BaseUrls, CustomProviderConfig } from "./chat-helpers";
import { logger } from "./logger";

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

    return { providers: data.providers ?? [] };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Convert resolved config to what createLlmModel() expects
// ---------------------------------------------------------------------------

export function resolveProviderForModel(
  config: ResolvedOrgModelConfig,
  modelDefinition: ModelDefinition,
): { apiKey: string; baseUrls: BaseUrls; customProviders: CustomProviderConfig[] } {
  const { provider, customProviderName } = modelDefinition;

  // Build custom providers list from org config
  const customProviders: CustomProviderConfig[] = config.providers
    .filter((p) => p.providerKey.startsWith("custom:"))
    .map((p) => ({
      name: p.displayName ?? p.providerKey.replace(/^custom:/, ""),
      protocol: p.protocol ?? "openai-compatible",
      baseUrl: p.baseUrl ?? "",
      modelIds: p.modelIds ?? [],
      apiKey: p.apiKey,
    }));

  // For custom providers, the apiKey comes from the custom provider config itself
  if (provider === "custom" && customProviderName) {
    const cp = customProviders.find((p) => p.name === customProviderName);
    return {
      apiKey: cp?.apiKey ?? "",
      baseUrls: buildBaseUrls(config),
      customProviders,
    };
  }

  // For built-in providers, find the matching provider config
  const providerConfig = config.providers.find(
    (p) => p.providerKey === provider,
  );

  return {
    apiKey: providerConfig?.apiKey ?? "",
    baseUrls: buildBaseUrls(config),
    customProviders,
  };
}

function buildBaseUrls(config: ResolvedOrgModelConfig): BaseUrls {
  const ollama = config.providers.find((p) => p.providerKey === "ollama");
  const azure = config.providers.find((p) => p.providerKey === "azure");
  return {
    ollama: ollama?.baseUrl,
    azure: azure?.baseUrl,
  };
}

// ---------------------------------------------------------------------------
// Build modelApiKeys map (for eval routes)
// ---------------------------------------------------------------------------

export function buildModelApiKeysFromOrgConfig(
  config: ResolvedOrgModelConfig,
): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const p of config.providers) {
    if (p.apiKey) {
      // Strip "custom:" prefix for custom providers — the eval runner
      // looks up by provider name (e.g. "anthropic", "openai")
      const key = p.providerKey.startsWith("custom:")
        ? p.providerKey
        : p.providerKey;
      keys[key] = p.apiKey;
    }
  }
  return keys;
}
