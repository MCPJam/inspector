import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";

const MAX_REASON = 500;

/**
 * Overruling the rule needs a reason, and the climb records who gave it. The
 * best so far moves to the last round that stands as kept.
 */
export function DecisionDialog({
  decision,
  onClose,
  onDecide,
}: {
  decision: "kept" | "reverted" | null;
  onClose: () => void;
  onDecide: (decision: "kept" | "reverted", reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const word = decision === "kept" ? "Keep" : "Revert";
  const trimmed = reason.trim();
  const submit = async () => {
    if (!decision || trimmed.length === 0) return;
    setPending(true);
    setFailure(null);
    try {
      await onDecide(decision, trimmed);
      setReason("");
      onClose();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The decision was not saved. Try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={decision !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{word} this round</DialogTitle>
          <DialogDescription>
            This overrules the rule. The reason is saved with your name.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="decision-reason">Reason</Label>
          <Textarea
            id="decision-reason"
            rows={3}
            maxLength={MAX_REASON}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={pending || trimmed.length === 0}>
            {word} it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
