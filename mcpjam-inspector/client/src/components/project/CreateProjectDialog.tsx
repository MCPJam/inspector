import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type { Organization } from "@/hooks/useOrganizations";

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Organizations the project may be created in. Callers filter out
   * seat-pending ones — every query for those is denied server-side, so
   * offering one would produce a project the user cannot then open.
   */
  organizations: Organization[];
  defaultOrganizationId?: string;
  /** Prefilled name; the caller owns the "Project N" uniqueness rule. */
  defaultName: string;
  onCreate: (name: string, organizationId?: string) => Promise<string> | void;
}

/**
 * Naming a project and choosing where it lives, before it exists.
 *
 * The switcher's "+" used to create a project outright with a generated name.
 * That is one gesture fewer but it produces a project called "New project 4"
 * in whichever organization happened to be active, and renaming it afterwards
 * is a trip to project settings.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  organizations,
  defaultOrganizationId,
  defaultName,
  onCreate,
}: CreateProjectDialogProps) {
  const [name, setName] = useState(defaultName);
  const [organizationId, setOrganizationId] = useState<string | undefined>(
    defaultOrganizationId,
  );
  const [isCreating, setIsCreating] = useState(false);

  // Reset on each open rather than on mount: the dialog is mounted for the
  // life of the switcher, and the prefill has to reflect the project list and
  // the active organization AT THE MOMENT the user opens it.
  useEffect(() => {
    if (!open) return;
    setName(defaultName);
    setOrganizationId(defaultOrganizationId);
  }, [open, defaultName, defaultOrganizationId]);

  // Guests and local installs have no organizations at all; there is nothing
  // to choose between, so the field would be an empty control.
  const showOrganizationSelect = organizations.length > 0;

  const handleCreate = async () => {
    if (!name.trim() || isCreating) return;
    setIsCreating(true);
    try {
      await onCreate(name.trim(), organizationId);
      onOpenChange(false);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader className="space-y-1">
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            Projects keep servers, evals and sessions separate.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-project-name">Name</Label>
            <Input
              id="create-project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleCreate();
                }
              }}
              autoFocus
            />
          </div>
          {showOrganizationSelect ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-project-organization">Organization</Label>
              <Select
                value={organizationId}
                onValueChange={(value) => setOrganizationId(value)}
              >
                <SelectTrigger
                  id="create-project-organization"
                  className="w-full"
                >
                  <SelectValue placeholder="Select an organization" />
                </SelectTrigger>
                <SelectContent>
                  {organizations.map((organization) => (
                    <SelectItem key={organization._id} value={organization._id}>
                      {organization.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!name.trim() || isCreating}>
            {isCreating ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
