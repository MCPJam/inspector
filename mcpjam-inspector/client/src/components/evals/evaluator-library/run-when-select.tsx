import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";

/** When a model question or judge runs, relative to the code checks. */
export type RunWhen =
  "always" | "required-pass" | "required-fail" | "per-match";

export const RUN_WHEN_OPTIONS: Record<
  RunWhen,
  { label: string; description: string }
> = {
  always: { label: "Always", description: "Every iteration" },
  "required-pass": {
    label: "Only when required checks pass",
    description: "Skip the model after a failure. Default for judges.",
  },
  "required-fail": {
    label: "Only when a required check fails",
    description: "Explain failures. Default for questions.",
  },
  "per-match": {
    label: "Once per match",
    description: "For questions that confirm what a check found",
  },
};

export type RunWhenSelectProps = {
  value: RunWhen;
  onChange: (value: RunWhen) => void;
  /** Limit the choices, e.g. a judge cannot run once per match. */
  options?: readonly RunWhen[];
  disabled?: boolean;
  id?: string;
};

const ALL = Object.keys(RUN_WHEN_OPTIONS) as RunWhen[];

/**
 * The gate that keeps a failed iteration cheap: with "Only when required
 * checks pass", no judge runs after a required check fails, and the scorecard
 * shows the judge as Skipped.
 */
export function RunWhenSelect({
  value,
  onChange,
  options = ALL,
  disabled,
  id,
}: RunWhenSelectProps) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const match = ALL.find((option) => option === next);
        if (match) onChange(match);
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label="Runs" className="w-72">
        <SelectValue>{RUN_WHEN_OPTIONS[value].label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            <span className="flex flex-col">
              <span>{RUN_WHEN_OPTIONS[option].label}</span>
              <span className="text-xs text-muted-foreground">
                {RUN_WHEN_OPTIONS[option].description}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
