import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadSelectedHostIds,
  saveSelectedHostIds,
  subscribeSelectedHostIds,
} from "@/lib/selected-host-storage";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";

// Project-scoped toggle key prefix. Deliberate divergence from the model
// toggle (`mcp-inspector-multi-model-enabled` is global): models are
// global resources; hosts are project entities; the toggle scopes
// accordingly so opening a different project doesn't inherit the
// previous project's compare-mode state.
const MULTI_HOST_ENABLED_STORAGE_KEY_PREFIX = "mcp-inspector-multi-host-enabled";

function multiHostEnabledKey(projectId: string): string {
  return `${MULTI_HOST_ENABLED_STORAGE_KEY_PREFIX}:${projectId}`;
}

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

/**
 * Defensive count-preserving derivation: mirrors the algorithm in
 * `replaceLeadHostId` so external `savePreviewedHostId` writes (global
 * host bar, project setup flows) that change the lead WITHOUT going
 * through `replaceLeadHostId` can't break column-count preservation.
 *
 * Branches (must match `replaceLeadHostId` exactly):
 *   - Stored empty + lead null → `[]`.
 *   - Stored empty + lead set → `[lead]` (seed).
 *   - Lead null + stored non-empty → stored as-is.
 *   - Lead at slot 0 → no change.
 *   - Lead at slot k > 0 → rotate to front (count preserved).
 *   - Lead not in stored + stored non-empty → replace slot 0 (count
 *     preserved). NEVER append.
 */
function deriveSelectedHostIds(
  storedHostIds: string[],
  previewedHostId: string | null,
): string[] {
  if (storedHostIds.length === 0) {
    return previewedHostId ? [previewedHostId] : [];
  }
  if (!previewedHostId) {
    return storedHostIds;
  }
  if (storedHostIds[0] === previewedHostId) {
    return storedHostIds;
  }
  const idx = storedHostIds.indexOf(previewedHostId);
  if (idx > 0) {
    // Rotate the existing entry to slot 0; preserve count.
    return [
      previewedHostId,
      ...storedHostIds.slice(0, idx),
      ...storedHostIds.slice(idx + 1),
    ];
  }
  // Lead is not in stored; replace slot 0 in-place. Do NOT append — that
  // would grow the column count on every external `savePreviewedHostId`
  // write that targets a host not already in the array.
  return [previewedHostId, ...storedHostIds.slice(1)];
}

export interface UsePersistedHostReturn {
  /**
   * The compare-column line-up, always normalized with the lead host id
   * (the per-project previewed host) at slot 0 and column count
   * preserved. See `deriveSelectedHostIds` for the count-preserving
   * branches — the hook re-applies the same algorithm at READ time so
   * external `savePreviewedHostId` writes that bypass `replaceLeadHostId`
   * can't grow the array.
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
 * exposed `selectedHostIds` cannot drift from the previewed host AND
 * cannot grow when the lead changes through any seam.
 *
 * Project scoping: both the array and the toggle are project-scoped at
 * the storage layer. Switching `projectId` re-reads from the new
 * project's keys; project A's compare line-up will not surface in
 * project B (and vice versa).
 *
 * `setSelectedHostIds` is React-state-authoritative for in-app writes;
 * `saveSelectedHostIds` only mirrors to localStorage without dispatching
 * an event, so the picker's promote-then-write-array sequence cannot
 * race with a listener that overwrites the new array. The host-switch
 * outside seam (`replaceLeadHostId`) fires the
 * `selected-host-ids-changed` channel so the array state still syncs
 * when the active host changes — and `usePreviewedHostId`'s own channel
 * handles lead changes (including direct `savePreviewedHostId` calls
 * from other surfaces, which the derivation re-shapes count-preservingly).
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

  // Load array + toggle from localStorage when projectId changes;
  // subscribe to outside-seam writes (host-snapshot apply,
  // MultiHostPicker promote) so the picker stays in sync. Re-running on
  // `projectId` is what makes switching projects re-read from the new
  // project's scoped keys — without it, project B would inherit the
  // last-loaded array from project A.
  useEffect(() => {
    if (typeof window === "undefined") {
      setIsInitialized(true);
      return;
    }
    setStoredHostIdsState(loadSelectedHostIds(projectId));
    try {
      if (projectId) {
        const storedMultiHostEnabled = localStorage.getItem(
          multiHostEnabledKey(projectId),
        );
        setMultiHostEnabledState(storedMultiHostEnabled === "true");
      } else {
        setMultiHostEnabledState(false);
      }
    } catch (error) {
      console.warn("Failed to load selected hosts from localStorage:", error);
    }
    setIsInitialized(true);

    // Array channel: fires only from `replaceLeadHostId` (outside-seam
    // host-switch primitive) and cross-tab `storage` events on any
    // project's array key. The subscriber re-reads with this hook's own
    // projectId — cross-project events that don't apply to this hook
    // simply re-read the same value.
    const unsubscribeIds = subscribeSelectedHostIds(() => {
      setStoredHostIdsState(loadSelectedHostIds(projectId));
    });
    return () => {
      unsubscribeIds();
    };
  }, [projectId]);

  // Persist multi-host toggle + mirror the array to localStorage on
  // every React state change. The array is React-state-authoritative for
  // in-app writes; this effect is the single backstop that keeps
  // localStorage in sync so setters never have to call
  // `saveSelectedHostIds` themselves.
  useEffect(() => {
    if (!isInitialized || typeof window === "undefined") return;
    if (!projectId) return;
    try {
      localStorage.setItem(
        multiHostEnabledKey(projectId),
        multiHostEnabled ? "true" : "false",
      );
    } catch (error) {
      console.warn("Failed to save selected hosts to localStorage:", error);
    }
    // `saveSelectedHostIds` does NOT dispatch a same-tab event, so this
    // won't feed back into React state.
    saveSelectedHostIds(projectId, storedHostIds);
  }, [isInitialized, multiHostEnabled, storedHostIds, projectId]);

  // Derived: defensively re-apply the count-preserving algorithm so an
  // external `savePreviewedHostId` write (global host bar, project setup
  // flows) that changes the lead WITHOUT rotating the array can't grow
  // our column count. The hook tolerates such writes by re-shaping the
  // line-up at READ time.
  const selectedHostIds = useMemo(
    () => deriveSelectedHostIds(storedHostIds, previewedHostId),
    [previewedHostId, storedHostIds],
  );

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
