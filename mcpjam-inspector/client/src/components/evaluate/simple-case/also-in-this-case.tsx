import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import type { TestStep } from "@/shared/steps";
import { leftoverStepLabel } from "./simple-case-model";

/**
 * The steps the three sections above cannot author — a second prompt, a pinned
 * `toolCall`. They are listed, not hidden: this form is the only editor on the
 * Evaluate surface, and a case that silently showed two of its four steps
 * would read as if the rest were gone.
 *
 * No remove control on purpose. `groupStepsIntoTurns` folds every assert and
 * interact into the turn that is open, so deleting a prompt re-parents each
 * step after it onto the previous turn — a grading change disguised as a row
 * deletion. The step list shows that structure; this list does not.
 */
export function AlsoInThisCase({
  steps,
  turnOrdinalByStepId,
  onOpenDeepEditor,
  readOnly = false,
}: {
  steps: TestStep[];
  turnOrdinalByStepId: Map<string, number>;
  onOpenDeepEditor: () => void;
  readOnly?: boolean;
}) {
  if (steps.length === 0) return null;
  return (
    <section className="space-y-2" data-testid="simple-case-also-in-this-case">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="text-[11px] font-medium text-foreground">
          Also in this case
        </Label>
        {readOnly ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={onOpenDeepEditor}
          >
            Edit in Steps
          </Button>
        )}
      </div>
      <div className="space-y-2">
        {steps.map((step) => (
          <div
            key={step.id}
            data-testid="simple-case-leftover-row"
            className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/10 px-3 py-2"
          >
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {leftoverStepLabel(step)}
            </span>
            <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
              turn {turnOrdinalByStepId.get(step.id) ?? 1}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
