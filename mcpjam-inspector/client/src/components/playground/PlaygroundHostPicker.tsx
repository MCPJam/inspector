import { useCallback } from "react";
import { useConvexAuth } from "convex/react";
import { useHostList } from "@/hooks/useClients";
import { usePersistedHost } from "@/hooks/use-persisted-host";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { replaceLeadHostId } from "@/lib/selected-host-storage";
import { MultiHostPicker } from "@/components/clients/MultiHostPicker";

interface PlaygroundHostPickerProps {
  projectId: string | null;
  disabled?: boolean;
  /**
   * Optional override for the "Multiple hosts" toggle. When set, the
   * picker calls this instead of the internal `setMultiHostEnabled` —
   * lets `PlaygroundMain` (Phase 4) inject mutual exclusion with
   * multi-model mode without forking the picker. The picker still reads
   * the current toggle value from `usePersistedHost` so the trigger and
   * popover stay in sync regardless of who flipped it.
   */
  onMultiHostEnabledChange?: (enabled: boolean) => void;
}

/**
 * Playground-specific wrapper around `MultiHostPicker`. Calls the
 * data/storage hooks (`useHostList`, `usePersistedHost`,
 * `usePreviewedHostId`) and threads values into the dumb picker. The only
 * promotion primitive used is `replaceLeadHostId` (canonical per Phase 1's
 * `selected-host-storage.ts` contract — never `setPreviewedHostId`
 * directly).
 *
 * Phase 2 scope: this picker persists `multiHostEnabled` + `selectedHostIds`
 * to localStorage but does NOT yet change the playground render path.
 * Phase 4 wires `selectedHostIds` into the multi-host grid. Until then,
 * toggling "Multiple hosts" on persists state but the playground stays
 * single-host.
 */
export function PlaygroundHostPicker({
  projectId,
  disabled,
  onMultiHostEnabledChange,
}: PlaygroundHostPickerProps) {
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({
    isAuthenticated,
    projectId,
  });
  const [previewedHostId] = usePreviewedHostId(projectId);
  const {
    selectedHostIds,
    setSelectedHostIds,
    multiHostEnabled,
    setMultiHostEnabled,
  } = usePersistedHost(projectId);

  const handlePromoteLead = useCallback(
    (hostId: string) => {
      if (!projectId) return;
      // Canonical single primitive: writes the per-project previewed host
      // key AND rotates the multi-host array in one atomic operation. See
      // `selected-host-storage.ts` and the plan's lead-host promotion path
      // decision.
      replaceLeadHostId(projectId, hostId);
    },
    [projectId],
  );

  return (
    <MultiHostPicker
      projectId={projectId}
      hosts={hosts}
      currentHostId={previewedHostId}
      selectedHostIds={selectedHostIds}
      multiHostEnabled={multiHostEnabled}
      onMultiHostEnabledChange={onMultiHostEnabledChange ?? setMultiHostEnabled}
      onSelectedHostIdsChange={setSelectedHostIds}
      onPromoteLead={handlePromoteLead}
      disabled={disabled || !projectId}
      isLoading={isLoading}
    />
  );
}
