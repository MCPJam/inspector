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
import { cn } from "@/lib/utils";

export interface RevokeApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keyName: string;
  isRevoking: boolean;
  onConfirm: () => Promise<void>;
}

/**
 * Type-the-name-to-confirm pattern — mirrors `ChatboxDeleteConfirmDialog`.
 * Revocation is immediate: once confirmed, any client still holding the
 * key value gets 401 within seconds.
 */
export function RevokeApiKeyDialog({
  open,
  onOpenChange,
  keyName,
  isRevoking,
  onConfirm,
}: RevokeApiKeyDialogProps) {
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    if (open) setConfirmText("");
  }, [open]);

  const phraseMatches = confirmText.trim() === keyName.trim();

  const handleConfirm = async () => {
    if (!phraseMatches || isRevoking) return;
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
        if (!next && isRevoking) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={!isRevoking}
        className="gap-4 sm:max-w-md"
      >
        <DialogHeader className="gap-2 text-left">
          <DialogTitle className="text-foreground">Revoke API key?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">
                  {keyName || "This key"}
                </span>{" "}
                will be revoked immediately. Any client still using it will
                start receiving 401 errors.
              </p>
              <p>You cannot undo this.</p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="api-key-revoke-confirm-input">
            Type the key name{" "}
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs font-normal text-foreground">
              {keyName}
            </kbd>{" "}
            to confirm
          </Label>
          <Input
            id="api-key-revoke-confirm-input"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={keyName}
            value={confirmText}
            disabled={isRevoking}
            onChange={(e) => setConfirmText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && phraseMatches && !isRevoking) {
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
            disabled={isRevoking}
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
            disabled={!phraseMatches || isRevoking}
            onClick={() => void handleConfirm()}
          >
            {isRevoking ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                Revoking…
              </>
            ) : (
              "Revoke key"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
