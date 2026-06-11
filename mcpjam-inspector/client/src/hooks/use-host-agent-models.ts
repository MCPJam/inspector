import { useEffect, useMemo, useState } from "react";
import { useConvexAuth } from "convex/react";
import { isMCPJamProvidedModel, type ModelDefinition } from "@/shared/types";
import { useSharedAppState } from "@/state/app-state-context";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { useCustomProviders } from "@/hooks/use-custom-providers";
import { useHostedOrgModelConfig } from "@/hooks/use-hosted-org-model-config";
import {
  applyGuestModelLocks,
  appendDetectedLocalOllamaModels,
} from "@/hooks/use-chat-session";
import {
  detectOllamaModels,
  detectOllamaToolCapableModels,
} from "@/lib/ollama-utils";
import {
  buildAvailableModels,
  buildAvailableModelsFromOrgConfig,
} from "@/components/chat-v2/shared/model-helpers";
import { HOSTED_MODE } from "@/lib/config";

/**
 * Models the host-config Agent tab can offer for `modelId`. Mirrors the
 * Playground's `availableModels` chain exactly (ChatTabV2 →
 * useHostedOrgModelConfig → use-chat-session's memo): project-scoped org
 * provider config with org-wide fallback, BYOK/custom providers, local
 * Ollama append, and guest locks — rather than the static SUPPORTED_MODELS
 * catalog, which only knows built-in providers.
 */
export function useHostAgentModels(): { availableModels: ModelDefinition[] } {
  const appState = useSharedAppState();
  const activeProject = appState.projects?.[appState.activeProjectId];
  const convexProjectId = activeProject?.sharedProjectId ?? null;
  const organizationId = activeProject?.organizationId ?? null;

  const { isAuthenticated } = useConvexAuth();
  const hostedOrgModelConfig = useHostedOrgModelConfig({
    projectId: convexProjectId,
    organizationId,
  });

  const {
    hasToken,
    getOpenRouterSelectedModels,
    getOllamaBaseUrl,
    getAzureBaseUrl,
  } = useAiProviderKeys();
  const { customProviders } = useCustomProviders();

  // Ollama model detection — local mode only, same as use-chat-session:
  // the browser may reach localhost but the hosted (Convex) chat path can't.
  const [ollamaModels, setOllamaModels] = useState<ModelDefinition[]>([]);
  const [isOllamaRunning, setIsOllamaRunning] = useState(false);
  useEffect(() => {
    if (HOSTED_MODE) {
      setIsOllamaRunning(false);
      setOllamaModels([]);
      return;
    }

    let cancelled = false;
    const checkOllama = async () => {
      const { isRunning, availableModels } = await detectOllamaModels(
        getOllamaBaseUrl()
      );
      if (cancelled) return;
      setIsOllamaRunning(isRunning);

      const toolCapable = isRunning
        ? await detectOllamaToolCapableModels(getOllamaBaseUrl())
        : [];
      if (cancelled) return;
      const toolCapableSet = new Set(toolCapable);
      setOllamaModels(
        availableModels.map((modelName) => ({
          id: modelName,
          name: modelName,
          provider: "ollama" as const,
          disabled: !toolCapableSet.has(modelName),
          disabledReason: toolCapableSet.has(modelName)
            ? undefined
            : "Model does not support tool calling",
        }))
      );
    };
    void checkOllama();
    const interval = window.setInterval(() => {
      void checkOllama();
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [getOllamaBaseUrl]);

  // Keep this branch-for-branch identical to use-chat-session's
  // `availableModels` memo so the host picker always matches Playground.
  const availableModels = useMemo(() => {
    if ((hostedOrgModelConfig?.providers.length ?? 0) > 0) {
      const orgModels = buildAvailableModelsFromOrgConfig(hostedOrgModelConfig);
      const orgModelsWithLocalOllama = appendDetectedLocalOllamaModels(
        orgModels,
        isOllamaRunning,
        ollamaModels
      );
      return applyGuestModelLocks(orgModelsWithLocalOllama, isAuthenticated);
    }

    const localModels = buildAvailableModels({
      hasToken,
      getOpenRouterSelectedModels,
      isOllamaRunning,
      ollamaModels,
      getAzureBaseUrl,
      customProviders,
    });
    const visibleModels = applyGuestModelLocks(localModels, isAuthenticated);
    if (HOSTED_MODE) {
      return visibleModels.filter((model) =>
        isMCPJamProvidedModel(String(model.id))
      );
    }
    return visibleModels;
  }, [
    hasToken,
    getOpenRouterSelectedModels,
    isOllamaRunning,
    ollamaModels,
    getAzureBaseUrl,
    isAuthenticated,
    customProviders,
    hostedOrgModelConfig,
  ]);

  return { availableModels };
}
