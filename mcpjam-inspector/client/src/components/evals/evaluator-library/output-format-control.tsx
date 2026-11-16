import { Slider } from "@mcpjam/design-system/slider";
import { Switch } from "@mcpjam/design-system/switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import { useId } from "react";
import { OutcomeTag, type Outcome } from "./outcome-tag";

export type OutputFormat = "passfail" | "score" | "categories";

export type JudgeOutput = {
  format: OutputFormat;
  /** Score format only: the bar a score must reach, from 0 to 1. */
  threshold: number;
  /** Categories format only: what each label counts as. */
  categories: readonly { label: string; countsAs: Outcome }[];
  explanationFirst: boolean;
};

const FORMATS: readonly { value: OutputFormat; label: string }[] = [
  { value: "passfail", label: "Pass/fail" },
  { value: "score", label: "Score 0 to 1" },
  { value: "categories", label: "Categories" },
];

const COUNTS_AS_LABEL: Record<Outcome, string> = {
  passed: "1.0",
  failed: "0.0",
  not_applicable: "N/A",
};

export type OutputFormatControlProps = {
  value: JudgeOutput;
  onChange: (value: JudgeOutput) => void;
};

/**
 * How a judge answers and what counts as a pass. Pass/fail and score map
 * straight to the evaluator result's score. Categories map each label to a
 * score or to Not applicable, which is never counted as a pass.
 */
export function OutputFormatControl({
  value,
  onChange,
}: OutputFormatControlProps) {
  const thresholdId = useId();
  const explanationId = useId();

  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={value.format}
        aria-label="Output format"
        onValueChange={(next) => {
          const format = FORMATS.find((f) => f.value === next);
          if (format) onChange({ ...value, format: format.value });
        }}
      >
        {FORMATS.map((format) => (
          <ToggleGroupItem key={format.value} value={format.value}>
            {format.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {value.format === "score" ? (
        <div className="flex items-center gap-3">
          <span
            id={thresholdId}
            className="text-xs font-semibold text-muted-foreground"
          >
            Pass at
          </span>
          <Slider
            thumbProps={{ "aria-labelledby": thresholdId }}
            min={0}
            max={1}
            step={0.05}
            value={[value.threshold]}
            onValueChange={([threshold]) => onChange({ ...value, threshold })}
            className="w-56"
          />
          <span className="font-mono text-sm tabular-nums text-foreground">
            {value.threshold.toFixed(2)}
          </span>
        </div>
      ) : null}

      {value.format === "categories" ? (
        <ul className="flex flex-col gap-1.5">
          {value.categories.map((category) => (
            <li
              key={category.label}
              className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5"
            >
              <span className="font-mono text-xs">{category.label}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                counts as
              </span>
              <OutcomeTag
                outcome={category.countsAs}
                label={COUNTS_AS_LABEL[category.countsAs]}
              />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-2">
        <Switch
          id={explanationId}
          checked={value.explanationFirst}
          onCheckedChange={(explanationFirst) =>
            onChange({ ...value, explanationFirst })
          }
        />
        <label htmlFor={explanationId} className="text-sm">
          Explanation before the answer
        </label>
      </div>
    </div>
  );
}
