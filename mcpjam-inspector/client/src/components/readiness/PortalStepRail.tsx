/**
 * The portal's steps down the left edge, marked the way the portal marks
 * them, with MCPJam's counts beside each.
 *
 * The app's `ProgressStepper` derives every step's look from one active
 * index, so it cannot show something to fix on step 3 while step 7 is open.
 */
import { Check } from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";

export interface RailStep {
  id: string;
  title: string;
  /** The portal's missing answers plus MCPJam's blockers. */
  toFix: number;
  likelyFlags: number;
  notChecked: number;
}

/**
 * The portal marks a step only once you leave it or open the review page.
 * A run reads every step, so it marks them all.
 */
export function portalMarks(
  left: ReadonlySet<number>,
  active: number,
  last: number,
  hasRun: boolean,
): (index: number) => boolean {
  const all = hasRun || left.has(last) || active === last;
  return (index) => all || left.has(index);
}

function Count({
  value,
  label,
  className,
}: {
  value: number;
  label: string;
  className: string;
}) {
  if (value <= 0) return null;
  return (
    <span
      title={`${value} ${label}`}
      className={cn(
        "flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-xs tabular-nums",
        className,
      )}
    >
      {value}
      <span className="sr-only"> {label}</span>
    </span>
  );
}

export function PortalStepRail({
  label,
  steps,
  active,
  marked,
  onSelect,
}: {
  label: string;
  steps: readonly RailStep[];
  active: number;
  marked: (index: number) => boolean;
  onSelect: (index: number) => void;
}) {
  return (
    <nav aria-label={label} className="w-56 shrink-0 pt-1">
      <ol className="flex flex-col gap-0.5">
        {steps.map((step, index) => {
          const toFix = marked(index) ? step.toFix : 0;
          // The portal's tick: nothing required is missing. Never a pass of
          // MCPJam's checks, whose open results show as counts beside it. The
          // review page has none, since MCPJam does not submit.
          const done = marked(index) && toFix === 0 && index < steps.length - 1;
          return (
            <li
              key={step.id}
              aria-current={index === active ? "step" : undefined}
            >
              <button
                type="button"
                onClick={() => onSelect(index)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  index === active
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/60",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full text-xs tabular-nums",
                    done
                      ? "bg-foreground text-background"
                      : "border border-muted-foreground/60 text-muted-foreground",
                  )}
                >
                  {done ? (
                    <Check className="size-3" strokeWidth={3} />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {step.title}
                  {done ? <span className="sr-only">, complete</span> : null}
                </span>
                <Count
                  value={toFix}
                  label="to fix"
                  className="bg-destructive/20 text-destructive"
                />
                <Count
                  value={step.likelyFlags}
                  label="likely flags"
                  className="border border-dashed border-warning text-foreground"
                />
                <Count
                  value={step.notChecked}
                  label="not checked"
                  className="border border-dashed border-muted-foreground/60 text-muted-foreground"
                />
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
