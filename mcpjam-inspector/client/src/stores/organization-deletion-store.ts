import { create } from "zustand";
import { flushSync } from "react-dom";

export const useOrganizationDeletionStore = create<{
  deletingOrganizationIds: string[];
}>(() => ({ deletingOrganizationIds: [] }));

export function beginOrganizationDeletion(organizationId: string) {
  // Unmount the org's query subscribers before the delete is sent, or Convex
  // re-runs them against the deleted org and each one throws server-side.
  flushSync(() =>
    useOrganizationDeletionStore.setState((state) => ({
      deletingOrganizationIds: [
        ...state.deletingOrganizationIds,
        organizationId,
      ],
    })),
  );
}

export function endOrganizationDeletion(organizationId: string) {
  useOrganizationDeletionStore.setState((state) => ({
    deletingOrganizationIds: state.deletingOrganizationIds.filter(
      (id) => id !== organizationId,
    ),
  }));
}
