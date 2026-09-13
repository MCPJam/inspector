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
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  pending: boolean;
  onConfirm: () => Promise<void>;
}) {
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
            Deleting “{name}” permanently removes the organization and its
            members’ access. This action cannot be undone.
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
            I understand that deleting this organization is permanent.
          </label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={!ready || pending}
            onClick={() => {
              if (ready && !pending) void onConfirm();
            }}
          >
            {pending ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <Trash2 aria-hidden="true" className="size-4" />
            )}
            {pending ? "Deleting..." : "Permanently delete organization"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
