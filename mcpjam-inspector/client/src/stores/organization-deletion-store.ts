import { create } from "zustand";
import { flushSync } from "react-dom";

export const useOrganizationDeletionStore = create<{
  deletingOrganizationId: string | null;
}>(() => ({ deletingOrganizationId: null }));

export function beginOrganizationDeletion(organizationId: string) {
  // Unmount the org's query subscribers before the delete is sent, or Convex
  // re-runs them against the deleted org and each one throws server-side.
  flushSync(() =>
    useOrganizationDeletionStore.setState({
      deletingOrganizationId: organizationId,
    }),
  );
}

export function endOrganizationDeletion() {
  useOrganizationDeletionStore.setState({ deletingOrganizationId: null });
}
