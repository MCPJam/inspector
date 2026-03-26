import { useEffect, useMemo, useState } from "react";
import type { ModelDefinition } from "@/shared/types";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { useCustomProviders } from "@/hooks/use-custom-providers";
import {
  detectOllamaModels,
  detectOllamaToolCapableModels,
} from "@/lib/ollama-utils";
import { buildAvailableModels } from "@/components/chat-v2/shared/model-helpers";

export function useAvailableEvalModels() {
  const {
    hasToken,
    getOpenRouterSelectedModels,
    getOllamaBaseUrl,
    getAzureBaseUrl,
  } = useAiProviderKeys();
  const { customProviders } = useCustomProviders();
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

  const availableModels = useMemo(
    () =>
      buildAvailableModels({
        hasToken,
        getOpenRouterSelectedModels,
        isOllamaRunning,
        ollamaModels,
        getAzureBaseUrl,
        customProviders,
      }),
    [
      hasToken,
      getOpenRouterSelectedModels,
      isOllamaRunning,
      ollamaModels,
      getAzureBaseUrl,
      customProviders,
    ],
  );

  return { availableModels };
}
