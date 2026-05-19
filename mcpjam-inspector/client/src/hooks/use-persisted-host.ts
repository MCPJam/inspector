import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadSelectedHostIds,
  saveSelectedHostIds,
  subscribeSelectedHostIds,
} from "@/lib/selected-host-storage";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";

const MULTI_HOST_ENABLED_STORAGE_KEY = "mcp-inspector-multi-host-enabled";

function normalizeSelectedHostIds(hostIds: string[]): string[] {
  const uniqueHostIds: string[] = [];
  const seen = new Set<string>();

  for (const hostId of hostIds) {
    if (typeof hostId !== "string") {
      continue;
    }

    const trimmed = hostId.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    uniqueHostIds.push(trimmed);
  }

  return uniqueHostIds;
}

export interface UsePersistedHostReturn {
  /**
   * The compare-column line-up, always normalized so the lead host id
   * (the per-project previewed host) sits at slot 0 followed by stored
   * secondaries with the lead filtered out. If no lead is set, this is
   * just the stored secondaries.
   */
  selectedHostIds: string[];
  /**
   * In-app setter. Updates React state and mirrors to localStorage via
   * `saveSelectedHostIds`. Does NOT dispatch the array channel — the
   * picker's promote-then-write-array sequence relies on this asymmetry
   * to avoid feeding back into React state and clobbering the longer
   * array. Outside-seam writes (`replaceLeadHostId`) DO dispatch.
   */
  setSelectedHostIds: (ids: string[]) => void;
  multiHostEnabled: boolean;
  setMultiHostEnabled: (enabled: boolean) => void;
}

/**
 * Hook to persist the user's multi-host compare line-up + the
 * "multiple hosts" toggle to localStorage. The lead host id is derived
 * from `usePreviewedHostId(projectId)` (per-project source of truth in
 * `lib/previewed-client-storage.ts`); this hook composes the two so the
 * exposed `selectedHostIds` cannot drift from the previewed host.
 *
 * `setSelectedHostIds` is React-state-authoritative for in-app writes;
 * `saveSelectedHostIds` only mirrors to localStorage without dispatching
 * an event, so the picker's promote-then-write-array sequence cannot
 * race with a listener that overwrites the new array. The host-switch
 * outside seam (`replaceLeadHostId`) fires the
 * `selected-host-ids-changed` channel so the array state still syncs
 * when the active host changes — and `usePreviewedHostId`'s own channel
 * handles lead changes.
 *
 * Not exported from a barrel — Phase 1 (this PR) only adds storage +
 * hook. Consumers will wire up in Phase 4.
 */
export function usePersistedHost(
  projectId: string | null,
): UsePersistedHostReturn {
  const [previewedHostId] = usePreviewedHostId(projectId);
  const [storedHostIds, setStoredHostIdsState] = useState<string[]>([]);
  const [multiHostEnabled, setMultiHostEnabledState] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  // Load array + toggle from localStorage on mount; subscribe to
  // outside-seam writes (host-snapshot apply, MultiHostPicker promote)
  // so the picker stays in sync.
  useEffect(() => {
    if (typeof window === "undefined") {
      setIsInitialized(true);
      return;
    }
    setStoredHostIdsState(loadSelectedHostIds());
    try {
      const storedMultiHostEnabled = localStorage.getItem(
        MULTI_HOST_ENABLED_STORAGE_KEY,
      );
      if (storedMultiHostEnabled === "true") {
        setMultiHostEnabledState(true);
      }
    } catch (error) {
      console.warn("Failed to load selected hosts from localStorage:", error);
    }
    setIsInitialized(true);

    // Array channel: fires only from `replaceLeadHostId` (outside-seam
    // host-switch primitive) and cross-tab `storage` events on the
    // array key. In-app `setSelectedHostIds` mirrors localStorage
    // silently — that's the asymmetry that fixes the regression where
    // in-app multi-select setters fed back into React state.
    const unsubscribeIds = subscribeSelectedHostIds(() => {
      setStoredHostIdsState(loadSelectedHostIds());
    });
    return () => {
      unsubscribeIds();
    };
  }, []);

  // Persist multi-host toggle + mirror the array to localStorage on
  // every React state change. The array is React-state-authoritative for
  // in-app writes; this effect is the single backstop that keeps
  // localStorage in sync so setters never have to call
  // `saveSelectedHostIds` themselves.
  useEffect(() => {
    if (!isInitialized || typeof window === "undefined") return;
    try {
      localStorage.setItem(
        MULTI_HOST_ENABLED_STORAGE_KEY,
        multiHostEnabled ? "true" : "false",
      );
    } catch (error) {
      console.warn("Failed to save selected hosts to localStorage:", error);
    }
    // `saveSelectedHostIds` does NOT dispatch a same-tab event, so this
    // won't feed back into React state.
    saveSelectedHostIds(storedHostIds);
  }, [isInitialized, multiHostEnabled, storedHostIds]);

  // Derived: always normalize so the lead sits at slot 0 with the lead
  // filtered out of secondaries. If lead is null, just expose the
  // stored secondaries. This is the invariant that keeps the lead key
  // and the array from drifting: callers see one consistent shape.
  const selectedHostIds = useMemo(() => {
    if (!previewedHostId) return storedHostIds;
    const filtered = storedHostIds.filter((id) => id !== previewedHostId);
    return [previewedHostId, ...filtered];
  }, [previewedHostId, storedHostIds]);

  const setSelectedHostIds = useCallback((hostIds: string[]) => {
    const normalized = normalizeSelectedHostIds(hostIds);
    // React state is the source of truth for the compare-column line-up
    // during in-app writes; the array-mirror effect above persists it.
    // The lead (previewed host) is owned by `usePreviewedHostId` /
    // `savePreviewedHostId`; this setter intentionally does NOT touch
    // the lead — promotion goes through `replaceLeadHostId`. Mutating
    // the lead from here would be the same anti-pattern that grew the
    // model array on every host switch.
    setStoredHostIdsState(normalized);
  }, []);

  const setMultiHostEnabled = useCallback((enabled: boolean) => {
    setMultiHostEnabledState(enabled);
  }, []);

  return {
    selectedHostIds,
    setSelectedHostIds,
    multiHostEnabled,
    setMultiHostEnabled,
  };
}
