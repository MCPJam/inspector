import { useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  evalSurfaceCardClass,
  evalSurfaceHeaderClass,
  evalSurfaceRowHoverClass,
} from "@/components/evals/eval-surface-chrome";
import { EVAL_DESTRUCTIVE_BUTTON_CLASS } from "@/components/evals/constants";
import { AddCaseMenu } from "./add-case-menu";

export interface AddCaseItem {
  label: "Describe" | "Generate" | "Import" | "Add manually";
  /** Shown after a pointer rests on the item for 2,000 ms. */
  description: string;
  onSelect(): void;
  disabled?: boolean;
  busyLabel?: string;
}

export interface SuiteCasesCardProps {
  /** Titles already read "Untitled test case" when blank. */
  cases: ReadonlyArray<{ caseId: string; title: string }>;
  /** null hides Add case; lockedReason then shows in its place. */
  addCaseItems: AddCaseItem[] | null;
  generateDisabledReason?: string;
  lockedReason?: string;
  /** "Review N draft cases". */
  headerExtra?: ReactNode;
  canDelete: boolean;
  onOpenCase(caseId: string): void;
  /** The card owns the confirm dialog and its toasts. */
  onDelete(caseId: string): Promise<void>;
}

const TRASH_BUTTON_CLASS =
  "shrink-0 rounded p-1.5 text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40";

/** The Test cases tab's card: one title row per case, with delete. */
export function SuiteCasesCard({
  cases,
  addCaseItems,
  generateDisabledReason,
  lockedReason,
  headerExtra,
  canDelete,
  onOpenCase,
  onDelete,
}: SuiteCasesCardProps) {
  const [caseToDelete, setCaseToDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const confirmDelete = async () => {
    if (!caseToDelete) return;
    setIsDeleting(true);
    try {
      await onDelete(caseToDelete.id);
      toast.success("Test case deleted");
      setCaseToDelete(null);
    } catch (error) {
      console.error("Failed to delete test case:", error);
      toast.error("Failed to delete test case");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <section
        className={evalSurfaceCardClass}
        data-testid="suite-settings-test-cases"
      >
        <div
          className={cn(
            evalSurfaceHeaderClass,
            "flex items-center justify-between gap-3 bg-muted/55 px-4 py-3",
          )}
        >
          <h3 className="text-sm font-semibold text-foreground">Test Cases</h3>
          <div className="flex shrink-0 items-center gap-2">
            {headerExtra}
            {addCaseItems ? (
              <AddCaseMenu
                items={addCaseItems}
                generateDisabledReason={generateDisabledReason}
              />
            ) : lockedReason ? (
              <span className="text-xs text-muted-foreground">
                {lockedReason}
              </span>
            ) : null}
          </div>
        </div>
        <ul className="divide-y divide-border/40">
          {cases.map((row) => (
            <li
              key={row.caseId}
              className={cn(
                "group flex items-center gap-1 pr-2",
                evalSurfaceRowHoverClass,
              )}
            >
              <button
                type="button"
                data-testid={`suite-settings-case-row-${row.caseId}`}
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-4 py-3 text-left"
                onClick={() => onOpenCase(row.caseId)}
              >
                <span className="text-sm font-medium text-foreground">
                  {row.title}
                </span>
              </button>
              {canDelete ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-testid={`suite-settings-case-delete-${row.caseId}`}
                      onClick={() =>
                        setCaseToDelete({ id: row.caseId, title: row.title })
                      }
                      aria-label={`Delete test case: ${row.title}`}
                      className={TRASH_BUTTON_CLASS}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent variant="muted">
                    Delete test case
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <Dialog
        open={caseToDelete != null}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setCaseToDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="size-5 text-destructive" aria-hidden />
              Delete test case
            </DialogTitle>
            <DialogDescription>
              Delete “{caseToDelete?.title || "Untitled test case"}”? This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCaseToDelete(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              className={EVAL_DESTRUCTIVE_BUTTON_CLASS}
              data-testid="suite-settings-case-delete-confirm"
              onClick={() => void confirmDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
