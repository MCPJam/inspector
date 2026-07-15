import { useEffect, useState } from "react";
import type { ModelDefinition } from "@/shared/types";
import {
  detectOllamaModels,
  detectOllamaToolCapableModels,
} from "@/lib/ollama-utils";
import { HOSTED_MODE } from "@/lib/config";

const OLLAMA_POLL_INTERVAL_MS = 30_000;

/**
 * Polls the local Ollama daemon and surfaces its models as picker entries,
 * marking tool-incapable models disabled. Local mode only: in hosted mode
 * the browser may reach localhost, but the hosted (Convex) chat path can't,
 * so the hook reports nothing rather than offering models chat can't run.
 */
export function useDetectedOllamaModels(getOllamaBaseUrl: () => string): {
  isOllamaRunning: boolean;
  ollamaModels: ModelDefinition[];
} {
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
    }, OLLAMA_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [getOllamaBaseUrl]);

  return { isOllamaRunning, ollamaModels };
}
