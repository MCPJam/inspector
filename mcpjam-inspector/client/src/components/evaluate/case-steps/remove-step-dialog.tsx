/** "Remove step": what happens to the assertions under a step being removed. */
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import type { DeleteActionPlan } from "../case-spine/case-spine-model";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function RemoveStepDialog({
  pending,
  onClose,
  onRemove,
}: {
  pending: DeleteActionPlan | null;
  onClose: () => void;
  /** true: the step and its assertions; false: the step only. */
  onRemove: (withAssertions: boolean) => void;
}) {
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && onClose()}>
      {pending ? (
        <DialogContent role="alertdialog">
          <DialogHeader>
            <DialogTitle>Remove step</DialogTitle>
            <DialogDescription>
              {pending.becomesLeading
                ? `Its ${plural(pending.movedChecks, "assertion")} would be graded before the first step.`
                : `Its ${plural(pending.movedChecks, "assertion")} will move under step ${pending.reparentTo?.ordinal} and be graded after it instead.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap">
            <Button variant="outline" size="sm" onClick={() => onRemove(false)}>
              Remove step
            </Button>
            <Button variant="outline" size="sm" onClick={() => onRemove(true)}>
              {pending.movedChecks === 1
                ? "Remove step and its assertion"
                : "Remove step and its assertions"}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
