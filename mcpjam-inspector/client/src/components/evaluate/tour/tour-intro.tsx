import { useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { TOUR_INTRO_COPY } from "./evaluate-tour-steps";

type Px = readonly [x: number, y: number, w: number, h: number];

const U = 4;

function Pixels({
  cells,
  className,
}: {
  cells: readonly Px[];
  className: string;
}) {
  return (
    <g className={className}>
      {cells.map(([x, y, w, h]) => (
        <rect
          key={`${x}-${y}-${w}-${h}`}
          x={x * U}
          y={y * U}
          width={w * U}
          height={h * U}
        />
      ))}
    </g>
  );
}

const SMALL_ROBOT_VISORS = ["fill-primary", "fill-success", "fill-info"];

/** A robot holding up a check-mark sign while three others look on. */
function GoodRobots() {
  return (
    <svg
      viewBox="0 0 160 120"
      className="h-28 w-auto"
      aria-hidden
      shapeRendering="crispEdges"
    >
      <Pixels cells={[[4, 0, 10, 8]]} className="fill-success" />
      <path
        d="M26 16 l6 6 l12 -12"
        className="fill-none stroke-success-foreground"
        strokeWidth={4}
        shapeRendering="auto"
      />
      <Pixels
        cells={[
          [8, 8, 2, 7],
          [10, 11, 8, 6],
          [9, 17, 10, 9],
          [7, 15, 2, 6],
          [11, 26, 2, 4],
          [15, 26, 2, 4],
        ]}
        className="fill-foreground/70"
      />
      <Pixels cells={[[12, 13, 5, 2]]} className="fill-primary" />
      {SMALL_ROBOT_VISORS.map((visor, index) => {
        const x = 22 + index * 6;
        return (
          <g key={visor}>
            <Pixels
              cells={[
                [x + 1, 9, 1, 1],
                [x, 10, 5, 4],
                [x, 15, 5, 6],
                [x + 1, 21, 1, 3],
                [x + 3, 21, 1, 3],
              ]}
              className="fill-muted-foreground"
            />
            <Pixels cells={[[x + 1, 11, 3, 1]]} className={visor} />
          </g>
        );
      })}
    </svg>
  );
}

/** The welcome modal over the empty Evaluate page. */
export function TourIntroCard({
  titleId,
  onStart,
  onSkip,
}: {
  titleId: string;
  /** Gets the pressed button, where the ghost cursor starts from. */
  onStart: (origin: HTMLElement) => void;
  onSkip: () => void;
}) {
  const startRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    startRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      className="relative w-[min(420px,calc(100%-32px))] rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
      data-testid="evaluate-tour-intro"
    >
      <button
        type="button"
        onClick={onSkip}
        aria-label="Close tour"
        className="absolute right-3 top-3 rounded-sm p-1 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
      <div className="flex flex-col items-center gap-5 px-8 pb-6 pt-8 text-center">
        <h2
          id={titleId}
          className="text-2xl font-semibold leading-tight tracking-[-0.02em] text-foreground"
        >
          {TOUR_INTRO_COPY.titleBefore}{" "}
          <span className="rounded bg-primary/15 px-1 text-primary">
            {TOUR_INTRO_COPY.titleEmphasis}
          </span>{" "}
          {TOUR_INTRO_COPY.titleAfter}
        </h2>
        <GoodRobots />
        <p className="max-w-[300px] text-base leading-relaxed text-muted-foreground">
          {TOUR_INTRO_COPY.body}
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
        <Button type="button" variant="outline" size="sm" onClick={onSkip}>
          {TOUR_INTRO_COPY.skip}
        </Button>
        <Button
          ref={startRef}
          type="button"
          size="sm"
          onClick={(event) => onStart(event.currentTarget)}
          data-tour-anchor="intro-start"
          data-testid="evaluate-tour-start"
        >
          {TOUR_INTRO_COPY.start}
        </Button>
      </div>
    </div>
  );
}
