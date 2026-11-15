import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { ArrowRight } from "lucide-react";
import { useId } from "react";
import { OutcomeTag, type Outcome } from "./outcome-tag";

export type ReviewerExampleRowProps = {
  /** Where the correction was made, e.g. "Run #3 · Iteration #4". */
  iterationLabel: string;
  judgeSaid: Outcome;
  reviewerSaid: Outcome;
  reviewer: string;
  /** The reviewer's reason, shown as the example's explanation. */
  note: string;
  included: boolean;
  onIncludedChange: (included: boolean) => void;
};

/**
 * A reviewer's correction of a past judge result, offered as a few-shot
 * example for the judge prompt. Excluding a row keeps the correction on the
 * iteration but stops it shaping future grades.
 */
export function ReviewerExampleRow({
  iterationLabel,
  judgeSaid,
  reviewerSaid,
  reviewer,
  note,
  included,
  onIncludedChange,
}: ReviewerExampleRowProps) {
  const checkboxId = useId();
  return (
    <div className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-2.5 border-b border-border bg-popover px-3 py-2.5 last:border-b-0">
      <Checkbox
        id={checkboxId}
        checked={included}
        onCheckedChange={(checked) => onIncludedChange(checked === true)}
        aria-label={`Use ${iterationLabel} as an example`}
        className="mt-0.5"
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <label
            htmlFor={checkboxId}
            className="text-sm font-medium text-card-foreground"
          >
            {iterationLabel}
          </label>
          <OutcomeTag outcome={judgeSaid} />
          <ArrowRight
            aria-label="changed to"
            className="size-3.5 text-muted-foreground"
          />
          <OutcomeTag outcome={reviewerSaid} />
          <span className="text-xs text-muted-foreground">by {reviewer}</span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">“{note}”</p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => onIncludedChange(!included)}
      >
        {included ? "Exclude" : "Include"}
      </Button>
    </div>
  );
}
