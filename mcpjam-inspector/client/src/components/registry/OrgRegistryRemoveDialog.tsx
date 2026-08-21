import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Loader2 } from "lucide-react";

/**
 * Confirm taking an entry off the organization's shelf.
 *
 * It exists because the blast radius is not the acting project: the entry is
 * visible to every project in the organization, so a mis-click withdraws a
 * server from colleagues who never opened this menu.
 *
 * Deliberately a plain confirm rather than the type-the-word dialog the
 * swarm delete uses. That weight is calibrated to destroying data; this
 * destroys none — the connected servers keep running and their provenance
 * rows survive, so the worst case is re-adding an entry. Asking someone to
 * type "delete" for that trains them to type it without reading.
 */
export function OrgRegistryRemoveDialog({
  open,
  onOpenChange,
  displayName,
  isRemoving,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayName: string;
  isRemoving: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove “{displayName}”?</DialogTitle>
          <DialogDescription>
            It disappears from the registry for everyone in your organization.
            Anyone who already connected it keeps their server — this only takes
            the entry off the shelf.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={isRemoving}
            onClick={onConfirm}
          >
            {isRemoving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
