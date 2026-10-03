/**
 * The one reasoning-effort control. Every surface that sets an effort (the
 * Playground chip, host Agent tab, environment / swarm composers, judge
 * pickers, eval matrices) renders this so the labels, the "hidden when
 * unknown" rule and the stale-value badge cannot drift.
 *
 * A toggle group in a popover. The trigger shows a terse level ("High"); the
 * specifics live in the tooltip. The caller passes the ALREADY-DERIVED list of
 * levels the row supports (`reasoningEffortOptions`):
 *
 *  - empty list, no saved value → renders nothing. An unknown capability is
 *    never guessed.
 *  - a saved value the list no longer offers → shown as "no longer supported"
 *    with a way to clear it (a loud `invalid_reasoning_effort` at run time is
 *    the alternative).
 *  - `disabledReason` → visible but inert, with the reason in the tooltip.
 */
import { useState } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Brain } from "lucide-react";
import type { ModelReasoningEffort } from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";

const EFFORT_LABELS: Record<ModelReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

const EFFORT_DETAILS: Record<ModelReasoningEffort, string> = {
  none: "no reasoning tokens",
  minimal: "the least reasoning the model allows",
  low: "quick answers with light reasoning",
  medium: "balanced reasoning",
  high: "deeper reasoning; slower and costlier",
  xhigh: "extra-deep reasoning; slowest and costliest",
  max: "the maximum reasoning budget",
};

export function reasoningEffortLabel(effort: ModelReasoningEffort): string {
  return EFFORT_LABELS[effort] ?? effort;
}

export function reasoningEffortDetail(effort: ModelReasoningEffort): string {
  return `${reasoningEffortLabel(effort)}: ${EFFORT_DETAILS[effort] ?? effort}`;
}

const DEFAULT_ITEM = "__default";

const effortTriggerVariants = cva(
  "inline-flex items-center gap-1 rounded-full border text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
  {
    variants: {
      variant: {
        /** Compact pill beside the model picker. */
        chip: "h-7 px-2 border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
        /** Full-width row in a settings form. */
        field:
          "h-9 w-full justify-between rounded-md px-3 border-input bg-transparent text-foreground hover:bg-accent",
      },
      stale: {
        true: "border-destructive/50 text-destructive",
        false: "",
      },
    },
    defaultVariants: { variant: "chip", stale: false },
  },
);

export type EffortControlProps = VariantProps<typeof effortTriggerVariants> & {
  /** Levels the row supports, low to high. Empty ⇒ capability unknown. */
  options: readonly ModelReasoningEffort[];
  value?: ModelReasoningEffort;
  onChange: (effort: ModelReasoningEffort | undefined) => void;
  disabled?: boolean;
  /** Why the control is inert; shown as a tooltip when `disabled`. */
  disabledReason?: string;
  /** Extra tooltip line, e.g. "Applies to GPT-5". */
  hint?: string;
  className?: string;
};

export function EffortControl({
  options,
  value,
  onChange,
  disabled = false,
  disabledReason,
  hint,
  variant,
  className,
}: EffortControlProps) {
  const [open, setOpen] = useState(false);
  const isStale = value !== undefined && !options.includes(value);
  if (options.length === 0 && value === undefined) return null;

  const valueLabel = value ? reasoningEffortLabel(value) : "Default";
  const triggerText = isStale
    ? `${valueLabel} · no longer supported`
    : variant === "field"
      ? valueLabel
      : value
        ? valueLabel
        : "Effort";
  const tooltip = disabled
    ? (disabledReason ?? "Reasoning effort is unavailable here")
    : isStale
      ? `${valueLabel} is no longer supported by this model. Pick another level or clear it.`
      : [
          value
            ? `Reasoning effort: ${reasoningEffortDetail(value)}`
            : "Reasoning effort: the model's default",
          hint,
        ]
          .filter(Boolean)
          .join(". ");

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      disabled={disabled}
      aria-label={`Reasoning effort: ${valueLabel}${isStale ? " (no longer supported)" : ""}`}
      data-testid="effort-control-trigger"
      data-stale={isStale ? "true" : undefined}
      className={cn(
        effortTriggerVariants({ variant, stale: isStale }),
        className,
      )}
    >
      <Brain className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{triggerText}</span>
    </Button>
  );

  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(variant === "field" ? "block w-full" : "inline-flex")}
            data-testid="effort-control-disabled"
            tabIndex={0}
          >
            {trigger}
          </span>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-auto max-w-[360px] p-2">
        <p className="px-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
          Reasoning effort
        </p>
        <ToggleGroup
          type="single"
          aria-label="Reasoning effort"
          variant="outline"
          size="sm"
          className="flex-wrap"
          // A stale saved level selects nothing, so pressing Default clears it.
          value={
            value && options.includes(value)
              ? value
              : isStale
                ? ""
                : DEFAULT_ITEM
          }
          onValueChange={(next) => {
            // Radix reports "" when the pressed item is pressed again; treat
            // that as no change rather than clearing by accident.
            if (!next) return;
            onChange(next === DEFAULT_ITEM ? undefined : (next as ModelReasoningEffort));
            setOpen(false);
          }}
        >
          <ToggleGroupItem value={DEFAULT_ITEM} aria-label="Default">
            Default
          </ToggleGroupItem>
          {options.map((level) => (
            <ToggleGroupItem
              key={level}
              value={level}
              aria-label={reasoningEffortLabel(level)}
              title={reasoningEffortDetail(level)}
            >
              {reasoningEffortLabel(level)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {isStale ? (
          <p className="px-1 pt-1.5 text-[11px] text-destructive">
            {valueLabel} is no longer supported by this model.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
