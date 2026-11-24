import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { TOUR_HANDOFF_COPY } from "./evaluate-tour-steps";
import {
  FeatureSpotlightActions,
  FeatureSpotlightDescription,
  FeatureSpotlightTitle,
} from "@mcpjam/design-system/feature-spotlight";
import type { GuidedTourHandoffEnd } from "@/components/guided-tour/use-guided-tour";
import { useAnchorRects } from "@/components/guided-tour/geometry";
import { TourCoachmark } from "@/components/guided-tour/coachmark";
import { TourSpotlight } from "@/components/guided-tour/spotlight";

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
  onDismiss: (reason: GuidedTourHandoffEnd) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
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
        target.closest('[data-testid="guided-tour-coachmark"]')
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
          <TourCoachmark
            anchor={anchor}
            bounds={bounds}
            placement="right"
            className="pointer-events-auto"
          >
            <FeatureSpotlightTitle>
              {TOUR_HANDOFF_COPY.title}
            </FeatureSpotlightTitle>
            <FeatureSpotlightDescription>
              {TOUR_HANDOFF_COPY.body}
            </FeatureSpotlightDescription>
            <FeatureSpotlightActions className="justify-end">
              <Button
                type="button"
                size="sm"
                onClick={() => onDismiss("got_it")}
              >
                {TOUR_HANDOFF_COPY.dismiss}
              </Button>
            </FeatureSpotlightActions>
          </TourCoachmark>
        </>
      ) : null}
    </div>
  );
}
