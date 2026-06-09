import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";

export interface CreateApiKeyOrganization {
  _id: string;
  name: string;
}

export interface CreateApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isCreating: boolean;
  /** MCPJam orgs the user belongs to. The key is scoped to the selected one. */
  organizations: CreateApiKeyOrganization[];
  orgsLoading: boolean;
  onCreate: (args: { name: string; organizationId: string }) => Promise<void>;
}

export function CreateApiKeyDialog({
  open,
  onOpenChange,
  isCreating,
  organizations,
  orgsLoading,
  onCreate,
}: CreateApiKeyDialogProps) {
  const [name, setName] = useState("");
  const [organizationId, setOrganizationId] = useState("");

  // Reset name on open; auto-select the org when there's exactly one (and
  // clear any stale selection that's no longer in the list).
  useEffect(() => {
    if (!open) return;
    setName("");
    setOrganizationId((prev) => {
      if (organizations.length === 1) return organizations[0]._id;
      if (prev && organizations.some((o) => o._id === prev)) return prev;
      return "";
    });
  }, [open, organizations]);

  const trimmed = name.trim();
  const hasOrgs = organizations.length > 0;
  const canCreate =
    trimmed.length > 0 && organizationId.length > 0 && !isCreating;

  const handleSubmit = async () => {
    if (!canCreate) return;
    try {
      await onCreate({ name: trimmed, organizationId });
    } catch {
      /* Error toast handled by caller */
    }
  };

  const singleOrg = organizations.length === 1;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isCreating) return;
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!isCreating} className="gap-4 sm:max-w-md">
        <DialogHeader className="gap-2 text-left">
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>
            Give this key a name so you can identify it later. The key value
            will be shown only once after creation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="api-key-name-input">Name</Label>
          <Input
            id="api-key-name-input"
            autoComplete="off"
            placeholder="e.g. ci-pipeline, local-laptop"
            value={name}
            disabled={isCreating}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canCreate) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="api-key-org-select">Organization</Label>
          {orgsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Loading organizations…
            </div>
          ) : !hasOrgs ? (
            <p className="text-sm text-muted-foreground">
              You don't belong to any organization yet. Create one first to mint
              an API key.
            </p>
          ) : (
            <Select
              value={organizationId}
              onValueChange={setOrganizationId}
              disabled={isCreating || singleOrg}
            >
              <SelectTrigger id="api-key-org-select">
                <SelectValue placeholder="Select an organization" />
              </SelectTrigger>
              <SelectContent>
                {organizations.map((org) => (
                  <SelectItem key={org._id} value={org._id}>
                    {org.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="text-xs text-muted-foreground">
            The key acts inside this organization. Requests are scoped to its
            projects and servers.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isCreating}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canCreate}
            onClick={() => void handleSubmit()}
          >
            {isCreating ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                Creating…
              </>
            ) : (
              "Create key"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
