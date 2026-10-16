import { useMemo } from "react";
import { useIsMemberActor } from "@/hooks/use-is-member-actor";
import type { ModelDefinition } from "@/shared/types";
import { useSharedAppState } from "@/state/app-state-context";
import { findProjectByAnyId } from "@/state/app-types";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { useCustomProviders } from "@/hooks/use-custom-providers";
import { useHostedOrgModelConfig } from "@/hooks/use-hosted-org-model-config";
import { useDetectedOllamaModels } from "@/hooks/use-detected-ollama-models";
import { composeAvailableModels } from "@/components/chat-v2/shared/available-models";
import { orgRequiresOwnKeys } from "@/shared/org-ai-key-policy";
import {
  useFreeTierOnly,
  useOutOfCreditsReason,
} from "@/hooks/useCreditBalance";
import { useHostedModelCatalog } from "@/hooks/use-hosted-model-catalog";
import { useOrgModelsHandoff } from "@/hooks/use-org-models-handoff";
import { useModelSelectionsSupported } from "@/hooks/use-project-environment-capability";

/**
 * Models the current user can pick on any model-picker surface (eval suite
 * and judge editors, the client builder's Agent tab, …): project-scoped org
 * provider config with org-wide fallback, local BYOK/custom providers,
 * locally-detected Ollama, and guest locks — the same
 * `composeAvailableModels` pipeline the Playground chat runs.
 *
 * The Playground itself doesn't call this hook (scenario embeds resolve a
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
  /**
   * Model ids the surface has saved. While the organization requires its own
   * keys, one it no longer offers stays in the list as an
   * `orgKeysDisallowedRow` instead of vanishing, so the surface keeps it
   * selected; pickers show it only on the trigger, as a warning.
   */
  savedModelIds?: readonly (string | null | undefined)[];
}): {
  availableModels: ModelDefinition[];
  /**
   * The scoped organization requires its own provider keys for AI features:
   * the list holds only organization models (and may be empty).
   */
  requireOrgKeys: boolean;
  /**
   * Opens the scoped organization's AI providers. Present only while the
   * organization requires its own keys and the viewer may manage its
   * providers: a picker with no organization model then offers "Add a
   * provider" instead of "Ask an organization admin". Absent otherwise, so a
   * picker off the policy looks as it always has.
   */
  onManageOrgProviders?: () => void;
  /**
   * Whether this deployment stores a saved model selection beside a model id
   * (`getCapabilities.modelSelections` for the scoped project). A picker that
   * saves a `ModelSelection` sends it only when this is true.
   */
  modelSelectionsSupported: boolean;
  /** Why the MCPJam rows are locked ("Out of MCPJam credits · resets in
   * 3h"), or null while the org can spend. */
  outOfCreditsReason: string | null;
} {
  const appState = useSharedAppState();
  const scopedProjectId =
    options?.projectId ?? appState.activeProjectId ?? null;
  const scopedProject = findProjectByAnyId(appState.projects, scopedProjectId);
  const convexProjectId =
    scopedProject?.sharedProjectId ?? options?.projectId ?? null;
  const organizationId = scopedProject?.organizationId ?? null;

  const isMemberActor = useIsMemberActor();
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
  // Why the MCPJam rows are locked ("… · resets in 3h"), or null.
  const outOfCreditsReason = useOutOfCreditsReason(organizationId);
  const outOfCredits = outOfCreditsReason !== null;
  const freeTierOnly = useFreeTierOnly(organizationId);
  const { hostedCatalog } = useHostedModelCatalog();
  const modelSelectionsSupported = useModelSelectionsSupported(convexProjectId);
  const manageOrgProviders = useOrgModelsHandoff(organizationId);
  const savedModelIdsKey = (options?.savedModelIds ?? [])
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .join("\u0001");
  const savedModelIds = useMemo(
    () => (savedModelIdsKey ? savedModelIdsKey.split("\u0001") : undefined),
    [savedModelIdsKey],
  );

  const availableModels = useMemo(
    () =>
      composeAvailableModels({
        orgConfig: hostedOrgModelConfig,
        isAuthenticated: isMemberActor === true,
        isOllamaRunning,
        ollamaModels,
        hasToken,
        getOpenRouterSelectedModels,
        getAzureBaseUrl,
        customProviders,
        outOfCredits,
        freeTierOnly,
        hostedCatalog,
        savedModelIds,
      }),
    [
      hostedOrgModelConfig,
      isMemberActor,
      isOllamaRunning,
      ollamaModels,
      hasToken,
      getOpenRouterSelectedModels,
      getAzureBaseUrl,
      customProviders,
      outOfCredits,
      freeTierOnly,
      hostedCatalog,
      savedModelIds,
    ]
  );

  const requireOrgKeys = orgRequiresOwnKeys(hostedOrgModelConfig);
  return {
    availableModels,
    modelSelectionsSupported,
    outOfCreditsReason,
    requireOrgKeys,
    ...(requireOrgKeys && manageOrgProviders
      ? { onManageOrgProviders: manageOrgProviders }
      : {}),
  };
}
