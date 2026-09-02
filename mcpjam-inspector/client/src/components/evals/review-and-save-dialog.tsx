import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import type { SuiteSettingsChange } from "./suite-settings-draft";

const MAX_NOTE_LENGTH = 500;

/**
 * What is about to be saved, before it is saved.
 *
 * The list is the point. A settings sheet that just has a Save button asks the
 * person to remember what they touched — across a scroll, across an
 * interruption, across a phone call — and the cost of misremembering is a
 * change to a shared suite that nobody notices until a run behaves differently.
 * Showing before and after per row turns that into a decision.
 *
 * The note is optional and lands on the suite's revision, which is the other
 * half: the next person reading the history gets a reason rather than a diff
 * they have to interpret.
 */
export function ReviewAndSaveDialog({
  open,
  onOpenChange,
  changes,
  conflicts,
  isCommitting,
  onConfirm,
  extraContent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  changes: SuiteSettingsChange[];
  conflicts: string[];
  isCommitting: boolean;
  onConfirm: (note: string) => void;
  /** Slot for the judge backtest panel (S6). */
  extraContent?: React.ReactNode;
}) {
  const [note, setNote] = useState("");

  // A reason belongs to one change. The dialog is mounted unconditionally by
  // the sheet, so closing it — including the parent's own `setReviewOpen(false)`
  // after a successful commit — leaves the text behind, and the next save would
  // file the previous change's explanation against it.
  useEffect(() => {
    if (!open) setNote("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Review and save</DialogTitle>
          <DialogDescription>
            {changes.length === 1
              ? "One setting will change for every future run of this suite."
              : `${changes.length} settings will change for every future run of this suite.`}
          </DialogDescription>
        </DialogHeader>

        {conflicts.length > 0 ? (
          <p
            className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning-foreground"
            data-testid="review-conflict-notice"
          >
            Someone else changed this suite while you were editing. Saving keeps
            your version of {conflicts.join(", ")}.
          </p>
        ) : null}

        <ul
          className="max-h-64 space-y-2 overflow-y-auto"
          data-testid="review-change-list"
        >
          {changes.map((change) => (
            <li
              key={change.key}
              className="rounded-md border border-border px-3 py-2"
              data-change-key={change.key}
            >
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
                {change.label}
              </p>
              <p className="mt-1 text-xs text-foreground">
                <span className="text-muted-foreground line-through">
                  {change.before}
                </span>{" "}
                <span aria-hidden>→</span> <span>{change.after}</span>
              </p>
            </li>
          ))}
        </ul>

        {extraContent}

        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
            Note (optional)
          </span>
          <textarea
            className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            rows={2}
            maxLength={MAX_NOTE_LENGTH}
            value={note}
            aria-label="Why you are making this change"
            placeholder="Why you are making this change"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isCommitting}
          >
            Keep editing
          </Button>
          <Button onClick={() => onConfirm(note)} disabled={isCommitting}>
            {isCommitting ? "Saving…" : "Save settings"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
