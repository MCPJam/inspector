import { useEffect, useMemo, useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import type { ModelDefinition } from "@/shared/types";
import { useSharedAppState } from "@/state/app-state-context";
import { useOllamaConfig } from "@/hooks/use-ollama-config";
import {
  detectOllamaModels,
  detectOllamaToolCapableModels,
} from "@/lib/ollama-utils";
import {
  buildAvailableModelsFromOrgConfig,
  type OrgVisibleConfig,
} from "@/components/chat-v2/shared/model-helpers";
import {
  canReadOrgModelConfig,
  type OrgModelProvider,
} from "@/hooks/use-org-model-config";

export function useAvailableEvalModels() {
  const { isAuthenticated } = useConvexAuth();
  const appState = useSharedAppState();
  const activeProject = appState.projects[appState.activeProjectId];
  const organizationId = activeProject?.organizationId ?? null;
  const visibleOrganizations = useQuery(
    "organizations:getMyOrganizations" as any,
    isAuthenticated ? ({} as any) : "skip",
  ) as Array<{ _id: string; myRole?: string }> | undefined;
  const visibleOrganization = visibleOrganizations?.find(
    (organization) => organization._id === organizationId,
  );
  const canQueryOrgModelConfig = Boolean(
    isAuthenticated &&
      organizationId &&
      canReadOrgModelConfig(visibleOrganization?.myRole),
  );
  const orgModelConfig = useQuery(
    "organizationModelProviders:getVisibleConfig" as any,
    canQueryOrgModelConfig && organizationId
      ? ({ organizationId } as any)
      : "skip",
  ) as { providers: OrgModelProvider[] } | undefined;
  const { getOllamaBaseUrl } = useOllamaConfig();
  const [ollamaModels, setOllamaModels] = useState<ModelDefinition[]>([]);
  const [isOllamaRunning, setIsOllamaRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const checkOllama = async () => {
      const { isRunning, availableModels } =
        await detectOllamaModels(getOllamaBaseUrl());

      if (cancelled) {
        return;
      }

      setIsOllamaRunning(isRunning);

      const toolCapableModels = isRunning
        ? await detectOllamaToolCapableModels(getOllamaBaseUrl())
        : [];
      if (cancelled) {
        return;
      }

      const toolCapableSet = new Set(toolCapableModels);
      setOllamaModels(
        availableModels.map((modelName) => {
          const supportsTools = toolCapableSet.has(modelName);
          return {
            id: modelName,
            name: modelName,
            provider: "ollama" as const,
            disabled: !supportsTools,
            disabledReason: supportsTools
              ? undefined
              : "Model does not support tool calling",
          };
        }),
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

  const availableModels = useMemo(() => {
    const orgModels = buildAvailableModelsFromOrgConfig(
      orgModelConfig as OrgVisibleConfig | undefined,
    );
    if (!isOllamaRunning || ollamaModels.length === 0) {
      return orgModels;
    }
    return orgModels.concat(
      ollamaModels.filter(
        (ollamaModel) =>
          !orgModels.some(
            (model) => String(model.id) === String(ollamaModel.id),
          ),
      ),
    );
  }, [orgModelConfig, isOllamaRunning, ollamaModels]);

  return { availableModels };
}
