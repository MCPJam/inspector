import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import type { ModelDefinition } from "@/shared/types";
import { useSharedAppState } from "@/state/app-state-context";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { useCustomProviders } from "@/hooks/use-custom-providers";
import { useHostedOrgModelConfig } from "@/hooks/use-hosted-org-model-config";
import { useDetectedOllamaModels } from "@/hooks/use-detected-ollama-models";
import { composeAvailableModels } from "@/components/chat-v2/shared/available-models";

/**
 * Models the current user can pick on any model-picker surface (eval suite
 * and judge editors, the client builder's Agent tab, …): project-scoped org
 * provider config with org-wide fallback, local BYOK/custom providers,
 * locally-detected Ollama, and guest locks — the same
 * `composeAvailableModels` pipeline the Playground chat runs.
 *
 * The Playground itself doesn't call this hook (chatbox embeds resolve a
 * host-provided project context first; see ChatTabV2 → useChatSession), but
 * it composes the identical pipeline, so pickers fed by either path offer
 * the same list.
 */
export function useAvailableModels(options?: {
  /**
   * Inspector-local project id (an `appState.projects` key) to scope the
   * org provider config to. Defaults to the active project. Pass it when
   * the surface is pinned to a specific project — e.g. an eval run's
   * project — rather than whatever project is globally active.
   */
  projectId?: string | null;
}): { availableModels: ModelDefinition[] } {
  const appState = useSharedAppState();
  const scopedProjectId =
    options?.projectId ?? appState.activeProjectId ?? null;
  const scopedProject = scopedProjectId
    ? appState.projects?.[scopedProjectId]
    : undefined;
  const convexProjectId = scopedProject?.sharedProjectId ?? null;
  const organizationId = scopedProject?.organizationId ?? null;

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
  const { isOllamaRunning, ollamaModels } =
    useDetectedOllamaModels(getOllamaBaseUrl);

  const availableModels = useMemo(
    () =>
      composeAvailableModels({
        orgConfig: hostedOrgModelConfig,
        isAuthenticated,
        isOllamaRunning,
        ollamaModels,
        hasToken,
        getOpenRouterSelectedModels,
        getAzureBaseUrl,
        customProviders,
      }),
    [
      hostedOrgModelConfig,
      isAuthenticated,
      isOllamaRunning,
      ollamaModels,
      hasToken,
      getOpenRouterSelectedModels,
      getAzureBaseUrl,
      customProviders,
    ]
  );

  return { availableModels };
}
