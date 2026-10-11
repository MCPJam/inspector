import { deleteRunBatch } from "@/lib/deletion-batch";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { EVAL_DESTRUCTIVE_BUTTON_CLASS } from "../evals/constants";

/** One history row: a launch, which is one run per client it fanned out to. */
export type RunLaunchDeleteTarget = {
  runIds: string[];
  runNumber: number;
  /** Named where rows from many suites share one table and run numbers repeat. */
  suiteName?: string | null;
};

/**
 * Confirm-then-delete for a run history row, shared by Evaluate's project and
 * suite run tables. Same copy and flow as the legacy suite results rail.
 *
 * Deleting a run that is still going is safe: the backend refuses its late
 * writes and the runner stops on its next check.
 */
export function useDeleteRunLaunch(
  deleteRun: ((runId: string) => Promise<unknown>) | undefined,
) {
  const [target, setTarget] = useState<RunLaunchDeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    if (!target || !deleteRun) return;
    setDeleting(true);
    try {
      const outcome = await deleteRunBatch(target.runIds, deleteRun);
      (outcome.refused ? toast.error : toast.success)(outcome.message);
      setTarget(outcome.remaining.length
        ? { ...target, runIds: outcome.remaining }
        : null);
    } finally {
      setDeleting(false);
    }
  };

  const count = target?.runIds.length ?? 0;
  const dialog = (
    <Dialog
      open={target != null}
      onOpenChange={(open) => {
        if (!open && !deleting) setTarget(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-destructive" />
            Delete run #{target?.runNumber}
            {target?.suiteName ? ` of ${target.suiteName}` : ""}
          </DialogTitle>
          <DialogDescription>
            {count > 1
              ? `Delete the ${count} selected runs in this launch and their results? Any remaining runs stay selected while deletion is in progress. This cannot be undone.`
              : "This deletes the run and its results. This cannot be undone."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setTarget(null)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            className={EVAL_DESTRUCTIVE_BUTTON_CLASS}
            onClick={confirm}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { request: setTarget, dialog };
}
