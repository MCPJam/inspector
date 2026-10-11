import { useDeletionAvailability } from "./useDeletionAvailability";
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@mcpjam/design-system/alert-dialog";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Trash2, Loader2 } from "lucide-react";

export function DeleteOrganizationDialog({
  open,
  onOpenChange,
  name,
  hasCancellationWindow,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  hasCancellationWindow: boolean;
  pending: boolean;
  onConfirm: (available: boolean) => Promise<void>;
}) {
  const { available, failed } = useDeletionAvailability(open);
  const cancellationWindow = available === true && hasCancellationWindow;
  const [confirmation, setConfirmation] = useState("");
  const [accessAcknowledged, setAccessAcknowledged] = useState(false);
  const [permanentAcknowledged, setPermanentAcknowledged] = useState(false);
  useEffect(() => {
    setConfirmation("");
    setAccessAcknowledged(false);
    setPermanentAcknowledged(false);
  }, [open, name]);
  const ready =
    confirmation === name && accessAcknowledged && permanentAcknowledged;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!pending) onOpenChange(value);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Organization?</AlertDialogTitle>
          <AlertDialogDescription>
            {available === null
              ? failed ? "Could not check deletion availability. Close this dialog and try again." : "Checking deletion availability…"
              : available === false
                ? `Deleting “${name}” immediately removes the organization. This cannot be cancelled.`
                : <>Starting deletion immediately blocks access to “{name}”. The deletion runs in the background
                    {cancellationWindow
                      ? "; data removal begins after a 48-hour cancellation window. Running sandboxes may expire during this window and cannot be restored."
                      : " and cannot be cancelled once data removal begins."}</>}

          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="delete-organization-name">
              Type “{name}” to confirm
            </Label>
            <Input
              id="delete-organization-name"
              placeholder="Organization name"
              autoComplete="off"
              value={confirmation}
              disabled={pending}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </div>
          <label className="flex items-start gap-3 text-sm text-foreground">
            <input
              type="checkbox"
              checked={accessAcknowledged}
              disabled={pending}
              onChange={(e) => setAccessAcknowledged(e.target.checked)}
              className="mt-1 accent-destructive"
            />
            I understand that all members will lose access to this organization.
          </label>
          <label className="flex items-start gap-3 text-sm text-foreground">
            <input
              type="checkbox"
              checked={permanentAcknowledged}
              disabled={pending}
              onChange={(e) => setPermanentAcknowledged(e.target.checked)}
              className="mt-1 accent-destructive"
            />
            I understand that the organization and its data will be permanently removed
            {cancellationWindow ? " after the cancellation window" : ""}.
          </label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={!ready || pending || available === null}
            onClick={() => {
              if (ready && !pending && available !== null) void onConfirm(available);
            }}
          >
            {pending ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <Trash2 aria-hidden="true" className="size-4" />
            )}
            {pending ? "Starting deletion…" : "Permanently delete organization"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
