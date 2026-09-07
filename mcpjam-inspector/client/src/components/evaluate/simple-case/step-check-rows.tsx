import { Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { CheckRow } from "../../evals/checks-section";
import type { Predicate } from "@/shared/eval-matching";
import { stepCheckLabel, type StepCheck } from "./simple-case-model";
import { StatusDot, overlayStatus, type SimpleCaseOverlay } from "./status-dot";

/**
 * Checks the author wrote as assert STEPS, rendered as first-class check rows
 * beside the case-level ones.
 *
 * Kept in their own id-keyed list rather than merged into `ChecksSection`:
 * that component is index-keyed and re-emits its whole array on every edit, so
 * a merged list would have to demultiplex each change back to its origin — and
 * one off-by-one would rewrite a step as a predicate, moving when it is graded.
 *
 * `CheckRow embedded` drops the shared card chrome and the whole-run kind
 * header so the row can be labelled by its position in the flow instead ("No
 * tool errors SO FAR" — a step assert reads the transcript at that point).
 */
export function StepCheckRows({
  checks,
  onChange,
  onRemove,
  availableTools,
  readOnly = false,
  overlay,
}: {
  checks: StepCheck[];
  onChange: (stepId: string, next: Predicate) => void;
  onRemove: (stepId: string) => void;
  availableTools?: string[];
  readOnly?: boolean;
  overlay?: SimpleCaseOverlay | null;
}) {
  if (checks.length === 0) return null;
  return (
    <ul className="space-y-2">
      {checks.map((check) => (
        <li
          key={check.stepId}
          data-testid="simple-case-step-check"
          data-step-id={check.stepId}
          className="space-y-2 rounded-md border border-border bg-muted/20 p-3"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-[11px] font-medium uppercase text-muted-foreground">
              {stepCheckLabel(check)}
            </p>
            <div className="flex items-center gap-1">
              <StatusDot status={overlayStatus(overlay, check.stepId)} />
              {readOnly ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground"
                  aria-label="Remove check"
                  onClick={() => onRemove(check.stepId)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
          <CheckRow
            embedded
            predicate={check.predicate}
            onChange={(next) => onChange(check.stepId, next)}
            availableTools={availableTools}
            readOnly={readOnly}
          />
        </li>
      ))}
    </ul>
  );
}
