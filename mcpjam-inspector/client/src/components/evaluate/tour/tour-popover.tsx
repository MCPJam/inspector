import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  TOUR_STOPS,
  type CoachmarkPlacement,
  type TourStop,
} from "./evaluate-tour-steps";
import { placePopover, type TourRect, type TourSize } from "./tour-geometry";

const ARROW_SIDE: Record<CoachmarkPlacement, string> = {
  bottom: "-top-[6px] border-l border-t",
  top: "-bottom-[6px] border-b border-r",
  right: "-left-[6px] border-b border-l",
};

/**
 * A card pinned beside `anchor` with an arrow pointing at it. Measures
 * itself, then places; until then it is laid out but invisible so the first
 * paint is already in the right spot.
 */
export function TourPopover({
  anchor,
  bounds,
  placement,
  labelledBy,
  className,
  children,
}: {
  anchor: TourRect;
  bounds: TourSize;
  placement: CoachmarkPlacement;
  labelledBy: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<TourSize | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setSize({ width: el.offsetWidth, height: el.offsetHeight });
  }, [children]);

  const spot = size ? placePopover(anchor, size, bounds, placement) : null;
  const arrowStyle = spot
    ? spot.placement === "right"
      ? { top: spot.arrow - 6 }
      : { left: spot.arrow - 6 }
    : undefined;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={labelledBy}
      className={cn(
        "absolute z-10 w-[352px] max-w-[calc(100%-24px)] rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg",
        !spot && "invisible",
        className,
      )}
      style={spot ? { left: spot.left, top: spot.top } : { left: 0, top: 0 }}
      data-testid="evaluate-tour-popover"
    >
      {spot ? (
        <span
          aria-hidden
          className={cn(
            "absolute h-3 w-3 rotate-45 border-border bg-popover",
            ARROW_SIDE[spot.placement],
          )}
          style={arrowStyle}
        />
      ) : null}
      {children}
    </div>
  );
}

/** "Setup → Run → Diagnose → Experiment → Monitor" with the current stop marked. */
function StopTrail({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {TOUR_STOPS.map((stop, index) => (
        <li key={stop.id} className="flex items-center gap-1.5">
          {index > 0 ? <span aria-hidden>→</span> : null}
          <span
            aria-current={index === current ? "step" : undefined}
            className={cn(
              index === current &&
                "border-b-2 border-primary pb-px font-medium text-foreground",
            )}
          >
            {stop.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function StopCoachmarkContent({
  stop,
  index,
  titleId,
  onNext,
  onSkip,
}: {
  stop: TourStop;
  index: number;
  titleId: string;
  /** Gets the pressed button, where the ghost cursor starts from. */
  onNext: (origin: HTMLElement) => void;
  onSkip: () => void;
}) {
  const isLast = index === TOUR_STOPS.length - 1;
  const nextRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    nextRef.current?.focus({ preventScroll: true });
  }, [index]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <StopTrail current={index} />
        <button
          type="button"
          onClick={onSkip}
          aria-label="Close tour"
          className="-m-1 rounded-sm p-1 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <div className="space-y-1.5">
        <h2 id={titleId} className="text-sm font-semibold text-foreground">
          {stop.title}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {stop.body}
        </p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {index + 1} of {TOUR_STOPS.length}
        </span>
        <div className="flex items-center gap-1">
          {isLast ? null : (
            <Button type="button" variant="ghost" size="sm" onClick={onSkip}>
              Skip tour
            </Button>
          )}
          <Button
            ref={nextRef}
            type="button"
            size="sm"
            onClick={(event) => onNext(event.currentTarget)}
            data-testid="evaluate-tour-next"
          >
            {isLast ? "Finish" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
