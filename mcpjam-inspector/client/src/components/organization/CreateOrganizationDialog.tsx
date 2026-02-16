import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useOrganizationMutations } from "@/hooks/useOrganizations";
import { toast } from "sonner";

interface CreateOrganizationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (organizationId: string) => void;
  required?: boolean;
}

function getDefaultOrgName(firstName?: string | null): string {
  const normalizedFirstName = firstName?.trim();
  if (!normalizedFirstName) return "My Org";
  return `${normalizedFirstName}'s Org`;
}

export function CreateOrganizationDialog({
  open,
  onOpenChange,
  onCreated,
  required = false,
}: CreateOrganizationDialogProps) {
  const { user } = useAuth();
  const defaultOrgName = useMemo(
    () => getDefaultOrgName(user?.firstName),
    [user?.firstName],
  );
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const { createOrganization } = useOrganizationMutations();

  useEffect(() => {
    if (!open) return;
    setName(defaultOrgName);
  }, [open, defaultOrgName]);

  const handleCreate = async () => {
    if (!name.trim()) return;

    setIsCreating(true);
    try {
      const organizationId = (await createOrganization({
        name: name.trim(),
      })) as string;
      toast.success("Organization created");
      setName("");
      onOpenChange(false);
      onCreated?.(organizationId);
    } catch (error) {
      toast.error((error as Error).message || "Failed to create organization");
    } finally {
      setIsCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && name.trim() && !isCreating) {
      handleCreate();
    }
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (required && !nextOpen) return;
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        className="sm:max-w-sm"
        showCloseButton={!required}
        onEscapeKeyDown={(event) => {
          if (required) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (required) event.preventDefault();
        }}
      >
        <DialogHeader className="space-y-1">
          <DialogTitle>Create organization</DialogTitle>
          <DialogDescription>
            Collaborate with your team and organize your work.
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <Input
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>
        <DialogFooter className="gap-2">
          {!required && (
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isCreating}
            >
              Cancel
            </Button>
          )}
          <Button onClick={handleCreate} disabled={!name.trim() || isCreating}>
            {isCreating ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
