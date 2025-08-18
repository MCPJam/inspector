import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

interface SaveRequestDialogProps {
  open: boolean;
  defaultTitle?: string;
  defaultDescription?: string;
  onCancel: () => void;
  onSave: (data: { title: string; description?: string }) => void;
}

export default function SaveRequestDialog({
  open,
  defaultTitle = "",
  defaultDescription = "",
  onCancel,
  onSave,
}: SaveRequestDialogProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState(defaultDescription);

  useEffect(() => {
    if (open) {
      setTitle(defaultTitle || "");
      setDescription(defaultDescription || "");
    }
  }, [open, defaultTitle, defaultDescription]);

  return (
    <Dialog open={open}>
      <DialogContent className="sm:max-w-md" onEscapeKeyDown={onCancel} onPointerDownOutside={onCancel}>
        <DialogHeader>
          <DialogTitle>Save request</DialogTitle>
          <DialogDescription>Give this request a memorable name and optional description.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <label className="text-xs font-medium">Name</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="My saved request"
              className="text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Description</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              className="text-sm h-20"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} size="sm">
            Cancel
          </Button>
          <Button
            onClick={() => {
              const trimmed = (title || "").trim();
              if (!trimmed) return;
              onSave({ title: trimmed, description: description?.trim() || undefined });
            }}
            size="sm"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


