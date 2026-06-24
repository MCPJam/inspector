import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import type { ModelDefinition } from "@/shared/types";
import { useSharedAppState } from "@/state/app-state-context";
import { findProjectByAnyId } from "@/state/app-types";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { useCustomProviders } from "@/hooks/use-custom-providers";
import { useHostedOrgModelConfig } from "@/hooks/use-hosted-org-model-config";
import { useDetectedOllamaModels } from "@/hooks/use-detected-ollama-models";
import { composeAvailableModels } from "@/components/chat-v2/shared/available-models";
import { useOutOfCredits } from "@/hooks/useCreditBalance";

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
   * Project to scope the org provider config to — either an inspector-local
   * `appState.projects` key or a Convex/shared project id (eval surfaces
   * carry `convexProjectId` from App.tsx; run rows store the Convex id).
   * Defaults to the active project. Pass it when the surface is pinned to
   * a specific project — e.g. an eval run's project — rather than whatever
   * project is globally active.
   */
  projectId?: string | null;
}): { availableModels: ModelDefinition[] } {
  const appState = useSharedAppState();
  const scopedProjectId =
    options?.projectId ?? appState.activeProjectId ?? null;
  const scopedProject = findProjectByAnyId(appState.projects, scopedProjectId);
  const convexProjectId =
    scopedProject?.sharedProjectId ?? options?.projectId ?? null;
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
  const outOfCredits = useOutOfCredits(organizationId);

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
        outOfCredits,
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
      outOfCredits,
    ]
  );

  return { availableModels };
}
