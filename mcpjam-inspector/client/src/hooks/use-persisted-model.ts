import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "mcp-inspector-selected-model";
const MULTI_MODEL_STORAGE_KEY = "mcp-inspector-selected-models";
const MULTI_MODEL_ENABLED_STORAGE_KEY = "mcp-inspector-multi-model-enabled";

function normalizeSelectedModelIds(modelIds: string[]): string[] {
  const uniqueModelIds: string[] = [];
  const seen = new Set<string>();

  for (const modelId of modelIds) {
    if (typeof modelId !== "string") {
      continue;
    }

    const trimmed = modelId.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    uniqueModelIds.push(trimmed);
  }

  return uniqueModelIds;
}

export interface UsePersistedModelReturn {
  selectedModelId: string | null;
  setSelectedModelId: (modelId: string | null) => void;
  selectedModelIds: string[];
  setSelectedModelIds: (modelIds: string[]) => void;
  multiModelEnabled: boolean;
  setMultiModelEnabled: (enabled: boolean) => void;
}

/**
 * Hook to persist the user's last selected model ID to localStorage.
 * Returns the selected model ID and a setter function.
 */
export function usePersistedModel(): UsePersistedModelReturn {
  const [selectedModelId, setSelectedModelIdState] = useState<string | null>(
    null,
  );
  const [selectedModelIds, setSelectedModelIdsState] = useState<string[]>([]);
  const [multiModelEnabled, setMultiModelEnabledState] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  // Load the selected model from localStorage on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          setSelectedModelIdState(stored);
        }

        const storedSelectedModels = localStorage.getItem(
          MULTI_MODEL_STORAGE_KEY,
        );
        if (storedSelectedModels) {
          const parsed = JSON.parse(storedSelectedModels);
          if (Array.isArray(parsed)) {
            setSelectedModelIdsState(
              normalizeSelectedModelIds(parsed as string[]),
            );
          }
        }

        const storedMultiModelEnabled = localStorage.getItem(
          MULTI_MODEL_ENABLED_STORAGE_KEY,
        );
        if (storedMultiModelEnabled === "true") {
          setMultiModelEnabledState(true);
        }
      } catch (error) {
        console.warn("Failed to load selected model from localStorage:", error);
      }
      setIsInitialized(true);
    }
  }, []);

  // Save the selected model to localStorage whenever it changes
  useEffect(() => {
    if (isInitialized && typeof window !== "undefined") {
      try {
        const leadModelId = selectedModelIds[0] ?? selectedModelId;

        if (leadModelId) {
          localStorage.setItem(STORAGE_KEY, leadModelId);
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }

        if (selectedModelIds.length > 0) {
          localStorage.setItem(
            MULTI_MODEL_STORAGE_KEY,
            JSON.stringify(selectedModelIds),
          );
        } else {
          localStorage.removeItem(MULTI_MODEL_STORAGE_KEY);
        }

        localStorage.setItem(
          MULTI_MODEL_ENABLED_STORAGE_KEY,
          multiModelEnabled ? "true" : "false",
        );
      } catch (error) {
        console.warn("Failed to save selected model to localStorage:", error);
      }
    }
  }, [isInitialized, multiModelEnabled, selectedModelId, selectedModelIds]);

  const setSelectedModelId = useCallback((modelId: string | null) => {
    setSelectedModelIdState(modelId);
    setSelectedModelIdsState((previous) => {
      if (!modelId) {
        return [];
      }

      const next = normalizeSelectedModelIds([
        modelId,
        ...previous.filter((existingId) => existingId !== modelId),
      ]);
      return next;
    });
  }, []);

  const setSelectedModelIds = useCallback((modelIds: string[]) => {
    const normalized = normalizeSelectedModelIds(modelIds);
    setSelectedModelIdsState(normalized);
    setSelectedModelIdState(normalized[0] ?? null);
  }, []);

  const setMultiModelEnabled = useCallback((enabled: boolean) => {
    setMultiModelEnabledState(enabled);
  }, []);

  return {
    selectedModelId,
    setSelectedModelId,
    selectedModelIds,
    setSelectedModelIds,
    multiModelEnabled,
    setMultiModelEnabled,
  };
}
