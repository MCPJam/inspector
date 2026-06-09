import { useState } from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";

export interface RevealOnceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string | null;
}

/**
 * One-shot reveal dialog for a freshly minted API key.
 *
 * The plaintext `sk_…` value is only ever in the WorkOS create response.
 * We display it here, give the user a Copy button (with the
 * Copy → Check feedback pattern from SkillsTab), and warn loudly that it
 * won't be shown again. The `value` prop is dropped when the dialog closes.
 */
export function RevealOnceDialog({
  open,
  onOpenChange,
  value,
}: RevealOnceDialogProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the user can still select + copy manually.
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setCopied(false);
        onOpenChange(next);
      }}
    >
      <DialogContent className="gap-4 sm:max-w-lg">
        <DialogHeader className="gap-2 text-left">
          <DialogTitle>Copy your API key</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-foreground">
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0 text-warning"
                  aria-hidden
                />
                <p className="text-sm">
                  This key won't be shown again. Copy it now and store it
                  somewhere safe. If you lose it, revoke it and create a new
                  one.
                </p>
              </div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
          <code className="flex-1 select-all overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground">
            {value ?? ""}
          </code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleCopy()}
            disabled={!value}
            aria-label="Copy API key"
          >
            {copied ? (
              <>
                <Check className="mr-1.5 size-3.5" aria-hidden /> Copied
              </>
            ) : (
              <>
                <Copy className="mr-1.5 size-3.5" aria-hidden /> Copy
              </>
            )}
          </Button>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" onClick={() => onOpenChange(false)}>
            I've saved it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
