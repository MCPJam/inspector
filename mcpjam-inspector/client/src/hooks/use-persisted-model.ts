import { useState, useEffect, useCallback } from "react";
import {
  loadSelectedModelId,
  loadSelectedModelIds,
  saveSelectedModelId,
  saveSelectedModelIds,
  subscribeSelectedModelId,
  subscribeSelectedModelIds,
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
 * The lead `selectedModelId` flows through `lib/selected-model-storage`
 * so outside seams (e.g. the playground's "apply host defaults" helper)
 * can update it via `saveSelectedModelId` or `replaceLeadModelId` and
 * this hook will re-read on the next event tick. The multi-model array
 * `selectedModelIds` is React-state-authoritative for in-app writes;
 * `saveSelectedModelIds` only mirrors to localStorage without dispatching
 * an event, so the picker's `setSelectedModel` + `setSelectedModelIds`
 * sequence cannot race with a listener that overwrites the new array.
 * The host-switch outside seam (`replaceLeadModelId`) fires its own
 * `selected-model-ids-changed` channel so multi-model state still syncs
 * when the active host's default model changes.
 *
 * The multi-model toggle stays owned by this hook.
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

    // Lead-id channel: any write to the single-model picker key
    // (including the host-snapshot helper and other-tab `storage`
    // events) re-reads the lead. In-app `setSelectedModelIds` does NOT
    // fire this channel — see lib/selected-model-storage for the
    // rationale.
    const unsubscribeLead = subscribeSelectedModelId(() => {
      setSelectedModelIdState(loadSelectedModelId());
    });
    // Array channel: fires only from `replaceLeadModelId` (outside-seam
    // host-switch primitive) and cross-tab `storage` events on the
    // array key. Keeping this narrow is what fixes the regression
    // where in-app multi-select setters fed back into React state.
    const unsubscribeIds = subscribeSelectedModelIds(() => {
      setSelectedModelIdsState(loadSelectedModelIds());
    });
    return () => {
      unsubscribeLead();
      unsubscribeIds();
    };
  }, []);

  // Persist multi-model toggle + mirror the selected-models array to
  // localStorage on every React state change. The array is React-state-
  // authoritative for in-app writes (see hook docblock); this effect is
  // the single backstop that keeps localStorage in sync, so setters
  // never have to call `saveSelectedModelIds` themselves — which keeps
  // them free of in-updater side effects that could race with later
  // value setStates in the same batch.
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
    // Mirror the array. `saveSelectedModelIds` does NOT dispatch a
    // same-tab event, so this won't feed back into React state.
    saveSelectedModelIds(selectedModelIds);
  }, [isInitialized, multiModelEnabled, selectedModelIds]);

  const setSelectedModelId = useCallback((modelId: string | null) => {
    // Persist + notify other listeners. The lead-id subscription above
    // will then sync this hook's React state on the next event tick,
    // keeping the lead model id consistent across all consumers.
    //
    // This setter ONLY updates the lead. It must NOT touch
    // `selectedModelIdsState` — every multi-model code path manages the
    // compare array explicitly via `setSelectedModelIds`. Mutating the
    // array here was an undocumented side effect that grew the column
    // count by one on every host-switch (the host-snapshot helper calls
    // `setSelectedModel(match)`, which routed through here), causing
    // "switch from MCPJam (2 columns) to ChatGPT" to render 3 columns.
    // Outside-seam writes that need to rotate the array (host switches)
    // go through `replaceLeadModelId`, which preserves count by design.
    saveSelectedModelId(modelId);
  }, []);

  const setSelectedModelIds = useCallback((modelIds: string[]) => {
    const normalized = normalizeSelectedModelIds(modelIds);
    // React state is the source of truth for the compare-column line-
    // up during in-app writes; the array-mirror effect above persists
    // it. `saveSelectedModelId` fires the lead channel, which only
    // re-syncs the lead state — the array we just committed is left
    // alone.
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
