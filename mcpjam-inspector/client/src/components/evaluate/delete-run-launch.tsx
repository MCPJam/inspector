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
  deleteRun: ((runId: string) => Promise<void>) | undefined,
) {
  const [target, setTarget] = useState<RunLaunchDeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    if (!target || !deleteRun) return;
    setDeleting(true);
    const pending = [...target.runIds];
    try {
      while (pending.length > 0) {
        await deleteRun(pending[0]);
        pending.shift();
        // Drop each deleted run from the target as it goes, so a retry
        // after a later failure only asks for the runs still left — a
        // deleted run would fail again and block the retry for good.
        setTarget({ ...target, runIds: [...pending] });
      }
      toast.success(
        target.runIds.length > 1
          ? `Deleted ${target.runIds.length} runs`
          : "Run deleted",
      );
      setTarget(null);
    } catch (error) {
      console.error("Failed to delete run(s):", error);
      toast.error("Failed to delete run");
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
              ? `This deletes all ${count} runs in this launch (one per client), with their results. This cannot be undone.`
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
