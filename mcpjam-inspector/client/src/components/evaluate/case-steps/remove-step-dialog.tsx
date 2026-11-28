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

/** Own assertions move or go with the step; later ones in its turn always move. */
function removalText(plan: DeleteActionPlan) {
  const to = plan.reparentTo?.ordinal;
  const lost = " would be graded before the first step.";
  const own = to
    ? ` will move under step ${to} and be graded after it instead.`
    : lost;
  return [
    plan.movedChecks && `Its ${plural(plan.movedChecks, "assertion")}${own}`,
    plan.movedFollowers &&
      `${plural(plan.movedFollowers, "later assertion")} in its turn${to ? ` will move to step ${to}'s turn.` : " would be graded before the first prompt."}`,
  ]
    .filter(Boolean)
    .join(" ");
}

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
  const open = pending?.needsConfirm === true;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {pending && open ? (
        <DialogContent role="alertdialog">
          <DialogHeader>
            <DialogTitle>Remove step</DialogTitle>
            <DialogDescription>{removalText(pending)}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap">
            <Button variant="outline" size="sm" onClick={() => onRemove(false)}>
              Remove step
            </Button>
            {pending.movedChecks > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRemove(true)}
              >
                {pending.movedChecks === 1
                  ? "Remove step and its assertion"
                  : "Remove step and its assertions"}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
