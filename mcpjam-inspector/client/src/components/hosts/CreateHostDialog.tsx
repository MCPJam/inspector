import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { useHostMutations } from "@/hooks/useHosts";
import { emptyHostConfigInputV2 } from "@/lib/host-config-v2";

interface CreateHostDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: (hostId: string) => void;
}

export function CreateHostDialog({
  isOpen,
  onClose,
  projectId,
  onCreated,
}: CreateHostDialogProps) {
  const { createHost } = useHostMutations();
  const [name, setName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const handleClose = () => {
    setName("");
    onClose();
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setIsSaving(true);
    try {
      const { hostId } = await createHost({
        projectId,
        name: trimmed,
        input: emptyHostConfigInputV2(),
      });
      toast.success(`Host "${trimmed}" created`);
      handleClose();
      onCreated(hostId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create host");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Host</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          <Label htmlFor="host-name">Name</Label>
          <Input
            id="host-name"
            placeholder="My Host"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!name.trim() || isSaving}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
