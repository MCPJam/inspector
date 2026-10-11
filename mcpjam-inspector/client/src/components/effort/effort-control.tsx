/**
 * The one reasoning-effort control. Every surface that sets an effort (the
 * Playground chip, host Agent tab, environment / swarm composers, judge
 * pickers, eval matrices) renders this so the labels, the "hidden when
 * unknown" rule and the stale-value badge cannot drift.
 *
 * A slider in a popover: `Effort <Level>` header, Faster ↔ Smarter, one stop
 * per option (Default, then each supported level low to high), and a
 * `Default` caption under the level the provider applies when nothing is
 * sent. Choosing Default sends `undefined`, never that level's value. The
 * trigger shows a terse level (`Med`); the specifics live in the tooltip. The
 * `inline` variant (the Playground, beside the model name) reads the full
 * level (`High`) and opens a row of level buttons, upward, instead of the
 * slider. The `buttons` variant (the client tab) is that row on the page
 * itself, with no popover. The
 * caller passes the ALREADY-DERIVED list of levels the row supports
 * (`reasoningEffortOptions`):
 *
 *  - empty list, no saved value → renders nothing. An unknown capability is
 *    never guessed.
 *  - a saved value the list no longer offers → shown as "no longer supported"
 *    with a way to clear it (a loud `invalid_reasoning_effort` at run time is
 *    the alternative).
 *  - `disabledReason` → visible but inert, with the reason in the tooltip.
 */
import { useEffect, useState } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Brain, CircleHelp } from "lucide-react";
import type { ModelReasoningEffort } from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { Slider } from "@mcpjam/design-system/slider";
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

const EFFORT_SHORT_LABELS: Record<ModelReasoningEffort, string> = {
  none: "None",
  minimal: "Min",
  low: "Low",
  medium: "Med",
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

/** Terse label for chips (`Med`, `Min`). */
export function reasoningEffortShortLabel(
  effort: ModelReasoningEffort,
): string {
  return EFFORT_SHORT_LABELS[effort] ?? effort;
}

export function reasoningEffortDetail(effort: ModelReasoningEffort): string {
  return `${reasoningEffortLabel(effort)}: ${EFFORT_DETAILS[effort] ?? effort}`;
}

const EFFORT_EXPLAINER =
  "Reasoning effort is how long the model thinks before it answers. Higher levels are smarter but slower and use more tokens. Default sends no effort, so the provider's own default applies.";

const effortTriggerVariants = cva(
  "inline-flex items-center gap-1 rounded-full border text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
  {
    variants: {
      variant: {
        /** Compact pill beside the model picker. */
        chip: "h-7 px-2 border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
        /** The row of level buttons on the page, for a settings form; no trigger. */
        buttons: "",
        /** Full level beside the model picker; opens a row of level buttons. */
        inline:
          "h-7 px-2 border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
        /** Trailing `· High` after a model name; no chrome of its own. */
        suffix:
          "h-7 gap-0.5 px-1 border-transparent bg-transparent text-muted-foreground hover:text-foreground",
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
  /**
   * The level the provider applies when no effort is sent
   * (`defaultReasoningEffort`). The `Default` caption sits under its stop;
   * unknown or not offered ⇒ under the Default stop. Display only.
   */
  defaultLevel?: ModelReasoningEffort;
  disabled?: boolean;
  /** Why the control is inert; shown as a tooltip when `disabled`. */
  disabledReason?: string;
  /** Extra tooltip line, e.g. "Applies to GPT-5". */
  hint?: string;
  className?: string;
};

/** Thumb diameter in px (`size-4`); Radix keeps the thumb inside the track. */
const THUMB_PX = 16;

/** Where Radix centres the thumb for `index` of `count` stops. */
function stopLeft(index: number, count: number): string {
  const percent = count > 1 ? (index / (count - 1)) * 100 : 0;
  const offset = (THUMB_PX / 2) * (1 - percent / 50);
  return `calc(${percent}% + ${offset}px)`;
}

export function EffortControl({
  options,
  value,
  onChange,
  defaultLevel,
  disabled = false,
  disabledReason,
  hint,
  variant,
  className,
}: EffortControlProps) {
  const [open, setOpen] = useState(false);
  // The stop the user moved to. Kept past the commit so arrow keys walk on
  // from it; dropped when the saved value changes or the popover reopens.
  const [localIndex, setLocalIndex] = useState<number | null>(null);
  useEffect(() => setLocalIndex(null), [value, open]);

  const isStale = value !== undefined && !options.includes(value);
  if (options.length === 0 && value === undefined) return null;

  // Stop 0 is Default (sends nothing); then each level, low to high.
  const stops: (ModelReasoningEffort | undefined)[] = [undefined, ...options];
  const savedIndex = value && !isStale ? stops.indexOf(value) : 0;
  const shownIndex = localIndex ?? savedIndex;
  const shownStop = stops[shownIndex];
  const defaultCaptionIndex =
    defaultLevel && options.includes(defaultLevel)
      ? stops.indexOf(defaultLevel)
      : 0;

  const valueLabel = value ? reasoningEffortLabel(value) : "Default";
  const shortLabel = value ? reasoningEffortShortLabel(value) : "Default";
  const triggerText =
    variant === "inline"
      ? `${valueLabel}${isStale ? " · no longer supported" : ""}`
      : variant === "suffix"
        ? value
          ? `· ${shortLabel}${isStale ? " · no longer supported" : ""}`
          : null
        : isStale
          ? `${shortLabel} · no longer supported`
          : value
            ? shortLabel
            : "Effort";
  const tooltip = disabled
    ? (disabledReason ?? "Reasoning effort is unavailable here")
    : isStale
      ? `${valueLabel} is no longer supported by this model. Pick another level or clear it.`
      : [
          value
            ? `Reasoning effort: ${reasoningEffortDetail(value)}`
            : defaultLevel && options.includes(defaultLevel)
              ? `Reasoning effort: the model's default (${reasoningEffortLabel(defaultLevel)})`
              : "Reasoning effort: the model's default",
          hint,
        ]
          .filter(Boolean)
          .join(". ");
  const headerLabel =
    localIndex === null && isStale
      ? valueLabel
      : shownStop
        ? reasoningEffortLabel(shownStop)
        : "Default";

  const thumbProps = {
    "aria-label": "Reasoning effort",
    "aria-valuetext": shownStop ? reasoningEffortLabel(shownStop) : "Default",
    "data-testid": "effort-control-slider",
  };

  // A stale value matches no button, so none reads as picked; Default then
  // clears it.
  const pickedIndex = isStale ? -1 : savedIndex;
  const levelButtons = (compact: boolean, afterPick?: () => void) => (
    <div
      role="radiogroup"
      aria-label="Reasoning effort"
      data-testid="effort-control-buttons"
      className="flex overflow-x-auto rounded-md border border-border"
    >
      {stops.map((stop, index) => {
        const picked = index === pickedIndex;
        return (
          <button
            key={stop ?? "__default"}
            type="button"
            role="radio"
            aria-checked={picked}
            disabled={disabled}
            data-testid={`effort-option-${stop ?? "default"}`}
            title={
              stop
                ? reasoningEffortDetail(stop)
                : defaultLevel && options.includes(defaultLevel)
                  ? `The model's default (${reasoningEffortLabel(defaultLevel)})`
                  : "The model's default"
            }
            onClick={() => {
              if (!picked) onChange(stop);
              afterPick?.();
            }}
            className={cn(
              "whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
              compact ? "h-7 px-2.5 text-xs" : "px-3 py-1.5 text-sm",
              index > 0 && "border-l border-border",
              picked
                ? "bg-muted font-semibold text-foreground"
                : "text-muted-foreground enabled:hover:bg-muted/50 enabled:hover:text-foreground",
            )}
          >
            {stop ? reasoningEffortLabel(stop) : "Default"}
          </button>
        );
      })}
      {/* On the page there is no popover for the stale note, so it rides at
          the end of the row; picking any level (or Default) replaces it. */}
      {compact && isStale ? (
        <span
          data-testid="effort-control-stale"
          title={tooltip}
          className="flex h-7 items-center whitespace-nowrap border-l border-border px-2.5 text-xs font-semibold text-destructive"
        >
          {valueLabel} · no longer supported
        </span>
      ) : null}
    </div>
  );

  if (variant === "buttons") {
    if (!disabled) return <div className={className}>{levelButtons(true)}</div>;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={className}
            data-testid="effort-control-disabled"
            tabIndex={0}
          >
            {levelButtons(true)}
          </div>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    );
  }

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
      {/* The suffix shows only its level; with none it keeps an icon so the
          popover stays reachable. */}
      {variant !== "suffix" || triggerText === null ? (
        <Brain className="size-3.5 shrink-0" aria-hidden="true" />
      ) : null}
      {triggerText !== null ? (
        <span className="truncate">{triggerText}</span>
      ) : null}
    </Button>
  );

  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex"
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

  const staleRow = isStale ? (
    <div className="mt-2 flex items-center justify-between gap-2">
      <p className="text-[11px] text-destructive">
        {valueLabel} is no longer supported by this model.
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-[11px]"
        onClick={() => {
          onChange(undefined);
          setOpen(false);
        }}
      >
        Clear
      </Button>
    </div>
  ) : null;

  const popoverTrigger = (
    <Tooltip>
      <TooltipTrigger asChild>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );

  if (variant === "inline") {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        {popoverTrigger}
        <PopoverContent
          side="top"
          align="start"
          className="w-auto max-w-[calc(100vw-2rem)] p-3"
          data-testid="effort-control-popover"
        >
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Reasoning effort
          </p>
          {levelButtons(false, () => setOpen(false))}
          {staleRow}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {popoverTrigger}
      <PopoverContent
        align="start"
        className="w-[260px] p-3"
        data-testid="effort-control-popover"
      >
        <div className="flex items-center justify-between gap-2">
          <p
            className="text-sm font-medium"
            data-testid="effort-control-header"
          >
            Effort{" "}
            <span
              className={cn(
                localIndex === null && isStale && "text-destructive",
              )}
            >
              {headerLabel}
            </span>
          </p>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="About reasoning effort"
                className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <CircleHelp className="size-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent
              variant="muted"
              side="top"
              className="max-w-[260px] leading-snug"
            >
              {EFFORT_EXPLAINER}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Only Default left (a stale value on a row that now offers no
            level): nothing to slide between, just the clear below. */}
        {stops.length > 1 ? (
          <div className="px-1 pt-4">
            <Slider
              min={0}
              max={stops.length - 1}
              step={1}
              value={[shownIndex]}
              onValueChange={([next]) => {
                if (next !== undefined) setLocalIndex(next);
              }}
              onValueCommit={([next]) => {
                if (next === undefined) return;
                // Radix commits only a moved thumb, so this is always a change.
                setLocalIndex(next);
                onChange(stops[next]);
              }}
              thumbProps={thumbProps}
            >
              {stops.map((stop, index) => (
                <span
                  key={stop ?? "__default"}
                  aria-hidden="true"
                  data-testid={`effort-stop-${stop ?? "default"}`}
                  className={cn(
                    "pointer-events-none absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
                    index <= shownIndex
                      ? "bg-primary-foreground"
                      : "bg-muted-foreground/50",
                  )}
                  style={{ left: stopLeft(index, stops.length) }}
                />
              ))}
            </Slider>
            <div className="relative mt-1.5 h-4" aria-hidden="true">
              <span
                data-testid="effort-default-caption"
                data-stop={stops[defaultCaptionIndex] ?? "default"}
                className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] text-muted-foreground"
                style={{ left: stopLeft(defaultCaptionIndex, stops.length) }}
              >
                Default
              </span>
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
              <span>Faster</span>
              <span>Smarter</span>
            </div>
          </div>
        ) : null}

        {staleRow}
      </PopoverContent>
    </Popover>
  );
}
