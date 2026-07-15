import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import type { XaaResourceApp } from "@/lib/xaa/types";

/**
 * Shared create/edit/delete state machine for resource-app registrations,
 * used by both the debugger's XAAResourceAppsSection and the setup center's
 * XAASetupAppsSection so behavior fixes land in both places.
 */
export function useRegistrationCrud(remove: (id: string) => Promise<void>) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<XaaResourceApp | null>(null);
  const [pendingDelete, setPendingDelete] = useState<XaaResourceApp | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setWizardOpen(true);
  };

  const openEdit = (app: XaaResourceApp) => {
    setEditing(app);
    setWizardOpen(true);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      await remove(pendingDelete.id);
      setPendingDelete(null);
    } catch {
      // The owning hook already surfaces the failure through its `error`
      // state; swallow here so it doesn't escape the click handler as an
      // unhandled rejection. The dialog stays open for retry/cancel.
    } finally {
      setIsDeleting(false);
    }
  };

  return {
    wizardOpen,
    setWizardOpen,
    editing,
    openCreate,
    openEdit,
    pendingDelete,
    setPendingDelete,
    isDeleting,
    confirmDelete,
  };
}

export type RegistrationCrud = ReturnType<typeof useRegistrationCrud>;

/** Delete-confirmation dialog for a registration; copy varies per surface. */
export function RegistrationDeleteDialog({
  crud,
  description,
}: {
  crud: RegistrationCrud;
  description: React.ReactNode;
}) {
  const { pendingDelete, setPendingDelete, isDeleting, confirmDelete } = crud;
  return (
    <AlertDialog
      open={pendingDelete !== null}
      onOpenChange={(open) => {
        if (!open) setPendingDelete(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void confirmDelete();
            }}
            disabled={isDeleting}
          >
            {isDeleting ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
