import { useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import introRobotsImage from "@/assets/evals/tour-intro-robots.png";
import { TOUR_INTRO_COPY } from "./evaluate-tour-steps";

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
        <img
          src={introRobotsImage}
          alt=""
          aria-hidden
          className="h-36 w-auto select-none"
          draggable={false}
        />
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
