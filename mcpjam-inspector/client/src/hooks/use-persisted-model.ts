import { useState, useEffect, useCallback } from "react";
import {
  loadSelectedModelId,
  saveSelectedModelId,
  subscribeSelectedModelId,
} from "@/lib/selected-model-storage";

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
 *
 * The lead `selectedModelId` flows through `lib/selected-model-storage`
 * so outside seams (e.g. the playground's "apply host defaults" helper)
 * can update it via `saveSelectedModelId(modelId)` and this hook will
 * re-read on the next event tick. Multi-model state stays owned here.
 */
export function usePersistedModel(): UsePersistedModelReturn {
  const [selectedModelId, setSelectedModelIdState] = useState<string | null>(
    null,
  );
  const [selectedModelIds, setSelectedModelIdsState] = useState<string[]>([]);
  const [multiModelEnabled, setMultiModelEnabledState] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  // Load the selected model from localStorage on mount + subscribe to
  // outside writes (e.g. host snapshots) so the picker stays in sync.
  useEffect(() => {
    if (typeof window === "undefined") {
      setIsInitialized(true);
      return;
    }
    setSelectedModelIdState(loadSelectedModelId());
    try {
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

    // Subscribe to lead-model writes from any source (this hook's setter,
    // another tab, or the playground host-snapshot helper).
    const unsubscribe = subscribeSelectedModelId(() => {
      setSelectedModelIdState(loadSelectedModelId());
    });
    return unsubscribe;
  }, []);

  // Persist multi-model state. Lead `selectedModelId` is persisted by the
  // setter directly via `saveSelectedModelId` (which also fires the
  // sync event), so this effect intentionally doesn't write that key.
  useEffect(() => {
    if (!isInitialized || typeof window === "undefined") return;
    try {
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
  }, [isInitialized, multiModelEnabled, selectedModelIds]);

  const setSelectedModelId = useCallback((modelId: string | null) => {
    // Persist + notify other listeners. The subscription effect above
    // will then sync this hook's React state on the next event tick,
    // keeping the lead model id consistent across all consumers.
    saveSelectedModelId(modelId);
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
    saveSelectedModelId(normalized[0] ?? null);
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
