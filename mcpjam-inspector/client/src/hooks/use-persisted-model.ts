import { useState, useEffect, useCallback } from "react";
import {
  loadSelectedModelId,
  loadSelectedModelIds,
  saveSelectedModelId,
  saveSelectedModelIds,
  subscribeSelectedModelId,
} from "@/lib/selected-model-storage";

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
 * Both the lead `selectedModelId` and the compare-column `selectedModelIds`
 * array flow through `lib/selected-model-storage` so outside seams (e.g.
 * the playground's "apply host defaults" helper) can update them via
 * `replaceLeadModelId(modelId)` and this hook will re-read on the next
 * event tick. The multi-model toggle stays owned here.
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
    setSelectedModelIdsState(loadSelectedModelIds());
    try {
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

    // Subscribe to selected-model writes from any source (this hook's
    // setters, another tab, or the playground host-snapshot helper).
    // Re-read both the lead and the array so `replaceLeadModelId` writes
    // propagate fully into React state.
    const unsubscribe = subscribeSelectedModelId(() => {
      setSelectedModelIdState(loadSelectedModelId());
      setSelectedModelIdsState(loadSelectedModelIds());
    });
    return unsubscribe;
  }, []);

  // Persist multi-model toggle. The lead and the array are persisted by
  // the storage module via the setter callbacks below (which also fire
  // the sync event); this effect only writes the toggle key.
  useEffect(() => {
    if (!isInitialized || typeof window === "undefined") return;
    try {
      localStorage.setItem(
        MULTI_MODEL_ENABLED_STORAGE_KEY,
        multiModelEnabled ? "true" : "false",
      );
    } catch (error) {
      console.warn("Failed to save selected model to localStorage:", error);
    }
  }, [isInitialized, multiModelEnabled]);

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
      // Also persist the new array so the compare column line-up
      // survives reloads — same as the lead key above.
      saveSelectedModelIds(next);
      return next;
    });
  }, []);

  const setSelectedModelIds = useCallback((modelIds: string[]) => {
    const normalized = normalizeSelectedModelIds(modelIds);
    setSelectedModelIdsState(normalized);
    saveSelectedModelIds(normalized);
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
