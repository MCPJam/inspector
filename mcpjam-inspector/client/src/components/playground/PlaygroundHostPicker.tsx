import { useConvexAuth } from "convex/react";
import { useHostList } from "@/hooks/useClients";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { MultiHostPicker } from "@/components/hosts/MultiHostPicker";

interface PlaygroundHostPickerProps {
  /**
   * The project id used for the `useHostList` query AND for
   * `usePreviewedHostId` (the per-project "lead host" key). This must
   * match the project id `PlaygroundMain` passes to its single
   * `usePersistedHost` call so the picker and grid share storage scope.
   *
   * In authed shared-project flows the playground prefers
   * `convexProjectId` over `activeProjectId`; the picker therefore
   * receives whichever id the parent chose (see `multiHostProjectId` in
   * `PlaygroundMain`). Using a different id here would scope the picker
   * to a different localStorage namespace than the grid and the
   * "Multiple hosts" toggle would appear to no-op.
   */
  projectId: string | null;
  disabled?: boolean;
  /**
   * Controlled `selectedHostIds`. Owned by `PlaygroundMain`'s single
   * `usePersistedHost` instance so picker writes and grid reads share
   * one source of truth. The picker MUST NOT call `usePersistedHost`
   * itself — `selected-host-storage.ts` deliberately does not dispatch
   * same-tab events on `saveSelectedHostIds` (the Phase-1 fix for the
   * multi-select regression), so two sibling hooks cannot stay in sync
   * via storage events. Lifting the state to the common parent is the
   * fix; this prop is the lift.
   */
  selectedHostIds: string[];
  /** Controlled `multiHostEnabled`. See `selectedHostIds`. */
  multiHostEnabled: boolean;
  onSelectedHostIdsChange: (ids: string[]) => void;
  onMultiHostEnabledChange: (enabled: boolean) => void;
  /**
   * Promote a host to lead. Implemented by the parent as
   * `replaceLeadHostId(projectId, hostId)` — the canonical write per
   * Phase 1's `selected-host-storage.ts` contract. The parent owns it
   * (rather than the picker calling `replaceLeadHostId` directly) so
   * the project id used for the write matches the project id used for
   * `usePersistedHost`; passing different ids would split the storage
   * scope between the promote write and the array read.
   */
  onPromoteLead: (hostId: string) => void;
}

/**
 * Playground-specific wrapper around `MultiHostPicker`. After Phase 4's
 * "lift state ownership" fix, the picker is a fully controlled component:
 * `selectedHostIds`, `multiHostEnabled`, their setters, and the
 * `onPromoteLead` callback all come from `PlaygroundMain`. The picker
 * only owns the data side of the wrapper (`useHostList`,
 * `usePreviewedHostId`) and threads everything into the dumb
 * `MultiHostPicker`.
 */
export function PlaygroundHostPicker({
  projectId,
  disabled,
  selectedHostIds,
  multiHostEnabled,
  onSelectedHostIdsChange,
  onMultiHostEnabledChange,
  onPromoteLead,
}: PlaygroundHostPickerProps) {
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({
    isAuthenticated,
    projectId,
  });
  const [previewedHostId] = usePreviewedHostId(projectId);

  return (
    <MultiHostPicker
      projectId={projectId}
      hosts={hosts}
      currentHostId={previewedHostId}
      selectedHostIds={selectedHostIds}
      multiHostEnabled={multiHostEnabled}
      onMultiHostEnabledChange={onMultiHostEnabledChange}
      onSelectedHostIdsChange={onSelectedHostIdsChange}
      onPromoteLead={onPromoteLead}
      disabled={disabled || !projectId}
      isLoading={isLoading}
    />
  );
}
