import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { TOUR_HANDOFF_COPY } from "./evaluate-tour-steps";
import type { EvaluateTourHandoffEnd } from "./use-evaluate-tour";
import { useAnchorRects } from "./tour-geometry";
import { TourPopover } from "./tour-popover";
import { TourSpotlight } from "./tour-spotlight";

/** `data-tour-anchor` on the real create-suite form. */
export const CREATE_SUITE_FORM_ANCHOR = "create-suite-form";

/**
 * "Your turn": the tour's last word, pinned to the real create-suite form.
 * It never blocks the form. Any press outside the note, Escape, or the form
 * going away (Cancel, navigation) dismisses it.
 */
export function TourHandoff({
  onDismiss,
}: {
  onDismiss: (reason: EvaluateTourHandoffEnd) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { rects, bounds, settled } = useAnchorRects(
    rootRef,
    [CREATE_SUITE_FORM_ANCHOR],
    "parent",
  );
  const anchor = rects[0] ?? null;
  const seenRef = useRef(false);
  const [formShown, setFormShown] = useState(false);
  const reducedMotion = useReducedMotion() ?? false;

  useEffect(() => {
    if (anchor) {
      seenRef.current = true;
      setFormShown(true);
    } else if (seenRef.current || settled) {
      onDismiss("form_closed");
    }
  }, [anchor, settled, onDismiss]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-testid="evaluate-tour-popover"]')
      ) {
        return;
      }
      onDismiss("clicked_away");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss("escape");
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onDismiss]);

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0 z-40"
      data-testid="evaluate-tour-handoff"
    >
      {/* Hides the landing that renders before the form route does. */}
      <AnimatePresence>
        {formShown || settled ? null : (
          <motion.div
            key="cover"
            data-testid="evaluate-tour-handoff-cover"
            className="absolute inset-0 bg-background"
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.3 }}
          />
        )}
      </AnimatePresence>
      {anchor ? (
        <>
          <TourSpotlight rects={[anchor]} />
          <TourPopover
            anchor={anchor}
            bounds={bounds}
            placement="right"
            labelledBy={titleId}
            className="pointer-events-auto w-[280px]"
          >
            <div className="space-y-3">
              <div className="space-y-1.5">
                <h2
                  id={titleId}
                  className="text-sm font-semibold text-foreground"
                >
                  {TOUR_HANDOFF_COPY.title}
                </h2>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {TOUR_HANDOFF_COPY.body}
                </p>
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onDismiss("got_it")}
                >
                  {TOUR_HANDOFF_COPY.dismiss}
                </Button>
              </div>
            </div>
          </TourPopover>
        </>
      ) : null}
    </div>
  );
}
