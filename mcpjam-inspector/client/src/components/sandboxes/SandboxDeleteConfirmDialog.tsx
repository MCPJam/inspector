import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Exact text the user must type (after trim) to enable permanent delete. */
export const SANDBOX_DELETE_CONFIRM_PHRASE = "delete";

export interface SandboxDeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sandboxName: string;
  isDeleting: boolean;
  onConfirm: () => Promise<void>;
}

export function SandboxDeleteConfirmDialog({
  open,
  onOpenChange,
  sandboxName,
  isDeleting,
  onConfirm,
}: SandboxDeleteConfirmDialogProps) {
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    if (open) setConfirmText("");
  }, [open]);

  const phraseMatches = confirmText.trim() === SANDBOX_DELETE_CONFIRM_PHRASE;

  const handleConfirm = async () => {
    if (!phraseMatches || isDeleting) return;
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      /* Error toast is handled by the caller */
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isDeleting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={!isDeleting}
        className="gap-4 sm:max-w-md"
      >
        <DialogHeader className="gap-2 text-left">
          <DialogTitle className="text-foreground">Delete sandbox?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">
                  {sandboxName || "This sandbox"}
                </span>{" "}
                will be removed from this workspace. The hosted link will stop
                working and saved usage history for this sandbox will be
                cleared.
              </p>
              <p>You cannot undo this.</p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="sandbox-delete-confirm-input">
            Type the word{" "}
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs font-normal text-foreground">
              {SANDBOX_DELETE_CONFIRM_PHRASE}
            </kbd>{" "}
            to confirm
          </Label>
          <Input
            id="sandbox-delete-confirm-input"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={SANDBOX_DELETE_CONFIRM_PHRASE}
            value={confirmText}
            disabled={isDeleting}
            onChange={(e) => setConfirmText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && phraseMatches && !isDeleting) {
                e.preventDefault();
                void handleConfirm();
              }
            }}
            className="font-mono"
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isDeleting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            className={cn(
              "border-destructive/80 text-destructive shadow-none",
              "hover:bg-destructive/10 hover:text-destructive",
              "focus-visible:border-destructive focus-visible:ring-destructive/25",
              "dark:hover:bg-destructive/15",
            )}
            disabled={!phraseMatches || isDeleting}
            onClick={() => void handleConfirm()}
          >
            {isDeleting ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                Deleting…
              </>
            ) : (
              "Delete permanently"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
