import { useEffect, useRef, useState } from "react";
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
  /**
   * Creates the project and resolves with its id. An empty string is the
   * caller's "handled failure" answer (it has already raised a toast) and
   * keeps the dialog open so the typed name survives a retry.
   */
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

  // Prefill on the closed → open transition, not on mount and not whenever a
  // default changes: the dialog stays mounted for the life of the switcher, so
  // the prefill has to reflect the project list and the active organization AT
  // THE MOMENT the user opens it — but a project created in another tab while
  // this is open must not overwrite the name they are halfway through typing.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setName(defaultName);
      setOrganizationId(defaultOrganizationId);
    }
    wasOpenRef.current = open;
  }, [open, defaultName, defaultOrganizationId]);

  // Guests and local installs have no organizations at all; there is nothing
  // to choose between, so the field would be an empty control.
  const showOrganizationSelect = organizations.length > 0;

  const handleCreate = async () => {
    if (!name.trim() || isCreating) return;
    setIsCreating(true);
    try {
      const projectId = await onCreate(name.trim(), organizationId);
      // "" is a handled failure that already raised its own toast; anything
      // else (an id, or a caller that returns nothing) succeeded. Closing on a
      // failure would drop the name and the organization the user chose and
      // send them back through the "+" to retype both.
      if (projectId !== "") {
        onOpenChange(false);
      }
    } catch {
      // An unexpected rejection must not escape as an unhandled promise from
      // a click handler. `onCreate` reports its own failures; the dialog's job
      // is to stay open so the input survives.
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
