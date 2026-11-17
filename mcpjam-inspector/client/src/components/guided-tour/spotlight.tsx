import { useId } from "react";
import { cn } from "@mcpjam/design-system/cn";
import type { TourRect } from "./geometry";

const PAD = 4;
const RADIUS = 10;

/**
 * Dims everything in its box except the given rects, which get a primary
 * ring. Drawn as one SVG mask so several anchors can be lit at once.
 */
export function TourSpotlight({
  rects,
  className,
}: {
  rects: readonly (TourRect | null)[];
  className?: string;
}) {
  const maskId = useId();
  const lit = rects.filter((rect): rect is TourRect => rect !== null);
  return (
    <svg
      className={cn("absolute inset-0 h-full w-full", className)}
      aria-hidden
      data-testid="guided-tour-spotlight"
    >
      <defs>
        <mask id={maskId}>
          <rect width="100%" height="100%" fill="white" />
          {lit.map((rect, index) => (
            <rect
              key={index}
              x={rect.x - PAD}
              y={rect.y - PAD}
              width={rect.width + PAD * 2}
              height={rect.height + PAD * 2}
              rx={RADIUS}
              fill="black"
            />
          ))}
        </mask>
      </defs>
      <rect
        width="100%"
        height="100%"
        mask={`url(#${maskId})`}
        className="fill-overlay opacity-50"
      />
      {lit.map((rect, index) => (
        <rect
          key={index}
          x={rect.x - PAD}
          y={rect.y - PAD}
          width={rect.width + PAD * 2}
          height={rect.height + PAD * 2}
          rx={RADIUS}
          className="fill-none stroke-primary"
          strokeWidth={2}
        />
      ))}
    </svg>
  );
}
