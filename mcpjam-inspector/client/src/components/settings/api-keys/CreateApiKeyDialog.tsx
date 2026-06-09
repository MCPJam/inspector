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

export interface CreateApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isCreating: boolean;
  onCreate: (args: { name: string }) => Promise<void>;
}

export function CreateApiKeyDialog({
  open,
  onOpenChange,
  isCreating,
  onCreate,
}: CreateApiKeyDialogProps) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  const trimmed = name.trim();
  const canCreate = trimmed.length > 0 && !isCreating;

  const handleSubmit = async () => {
    if (!canCreate) return;
    try {
      await onCreate({ name: trimmed });
    } catch {
      /* Error toast handled by caller */
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isCreating) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={!isCreating}
        className="gap-4 sm:max-w-md"
      >
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
