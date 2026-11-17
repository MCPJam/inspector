import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  FeatureSpotlightActions,
  FeatureSpotlightCard,
  FeatureSpotlightCloseButton,
  FeatureSpotlightDescription,
  FeatureSpotlightPointer,
  FeatureSpotlightTitle,
} from "@mcpjam/design-system/feature-spotlight";
import {
  placePopover,
  type CoachmarkPlacement,
  type TourRect,
  type TourSize,
} from "./geometry";

/** Where the pointer sits on each side, and which way it turns. */
const POINTER_CLASS: Record<CoachmarkPlacement, string> = {
  top: "-translate-y-px",
  bottom: "translate-y-px rotate-180",
  right: "rotate-90",
};

function pointerStyle(
  placement: CoachmarkPlacement,
  arrow: number,
): CSSProperties {
  if (placement === "top") return { left: arrow - 7, top: "100%" };
  if (placement === "bottom") return { left: arrow - 7, bottom: "100%" };
  // Rotated about its center: a 14x7 box whose base lands 1px inside the card.
  return { left: -9.5, top: arrow - 3.5 };
}

/**
 * A `FeatureSpotlight` card pinned beside `anchor`, for tours that position
 * cards themselves over a dimmed stage. Measures itself, then places; until
 * then it is laid out but transparent so the first paint is already in place.
 * Transparent, not `invisible`: hidden content can't take focus, and the
 * step content focuses Next as it mounts.
 */
export function TourCoachmark({
  anchor,
  bounds,
  placement,
  className,
  children,
}: {
  anchor: TourRect;
  bounds: TourSize;
  placement: CoachmarkPlacement;
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

  return (
    <FeatureSpotlightCard
      ref={ref}
      role="dialog"
      className={cn(
        "absolute z-10 max-w-[calc(100%-24px)]",
        !spot && "pointer-events-none opacity-0",
        className,
      )}
      style={spot ? { left: spot.left, top: spot.top } : { left: 0, top: 0 }}
      data-testid="guided-tour-coachmark"
    >
      {spot ? (
        <FeatureSpotlightPointer
          className={cn("absolute", POINTER_CLASS[spot.placement])}
          style={pointerStyle(spot.placement, spot.arrow)}
        />
      ) : null}
      {children}
    </FeatureSpotlightCard>
  );
}

/** "Setup → Define → …" with the current step marked. */
function StepTrail({
  labels,
  current,
}: {
  labels: readonly string[];
  current: number;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 pr-6 text-xs text-muted-foreground">
      {labels.map((label, index) => (
        <li key={label} className="flex items-center gap-1.5">
          {index > 0 ? <span aria-hidden>→</span> : null}
          <span
            aria-current={index === current ? "step" : undefined}
            className={cn(
              index === current &&
                "border-b-2 border-primary pb-px font-medium text-foreground",
            )}
          >
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * One stop of a multi-step tour: the trail, the copy, a step count, and
 * Skip tour / Next (Finish on the last stop). Focuses Next on each stop so
 * Enter advances.
 */
export function TourStepContent({
  labels,
  index,
  title,
  body,
  onNext,
  onSkip,
}: {
  labels: readonly string[];
  index: number;
  title: string;
  body: string;
  /** Gets the pressed button, where a ghost cursor starts from. */
  onNext: (origin: HTMLElement) => void;
  onSkip: () => void;
}) {
  const isLast = index === labels.length - 1;
  const nextRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    nextRef.current?.focus({ preventScroll: true });
  }, [index]);

  return (
    <>
      <FeatureSpotlightCloseButton onClick={onSkip} aria-label="Close tour" />
      <StepTrail labels={labels} current={index} />
      <FeatureSpotlightTitle className="mt-1">{title}</FeatureSpotlightTitle>
      <FeatureSpotlightDescription>{body}</FeatureSpotlightDescription>
      <FeatureSpotlightActions className="justify-between">
        <span className="text-xs text-muted-foreground">
          {index + 1} of {labels.length}
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
            data-testid="guided-tour-next"
          >
            {isLast ? "Finish" : "Next"}
          </Button>
        </div>
      </FeatureSpotlightActions>
    </>
  );
}
