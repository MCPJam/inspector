import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  TOUR_EXAMPLE_SUITE_NAME,
  TOUR_STOPS,
  type TourScreen,
  type TourStopId,
} from "./evaluate-tour-steps";
import type { EvaluateTourController } from "./use-evaluate-tour";
import {
  TourGhostCursor,
  type GhostCursorHandle,
} from "@/components/guided-tour/ghost-cursor";
import { findAnchor, useAnchorRects } from "@/components/guided-tour/geometry";
import { TourSpotlight } from "@/components/guided-tour/spotlight";
import {
  TourCoachmark,
  TourStepContent,
} from "@/components/guided-tour/coachmark";
import { useTourPlayer } from "@/components/guided-tour/use-tour-player";
import { TourIntroCard } from "./tour-intro";
import { TourHandoff } from "./tour-handoff";
import { TourCreateScreen, TourSetupScreen } from "./tour-screens-setup";
import { TourCaseScreen, TourDiagnoseScreen } from "./tour-screens-case";
import { TourMonitorScreen } from "./tour-screen-monitor";

/**
 * The Evaluate tour. Mount it inside a `relative` box that covers the
 * Evaluate tab; it fills that box. `intro` and `stage` share one overlay so
 * the ghost cursor carries over from the welcome modal into the first stop.
 */
export function EvaluateTour({ tour }: { tour: EvaluateTourController }) {
  if (tour.phase === "closed") return null;
  if (tour.phase === "handoff") {
    return <TourHandoff onDismiss={tour.dismissHandoff} />;
  }
  return <TourStage tour={tour} />;
}

type StageScreen = "intro" | TourScreen;

const SCREEN_FADE_MS = 450;
const COACHMARK_FADE_MS = 250;
const EASE_IN_OUT = [0.4, 0, 0.2, 1] as const;
const STOP_LABELS = TOUR_STOPS.map((stop) => stop.label);

function TourScreenView({
  screen,
  typedName,
}: {
  screen: TourScreen;
  typedName: string;
}) {
  switch (screen) {
    case "create":
      return <TourCreateScreen typedName={typedName} />;
    case "setup":
      return <TourSetupScreen />;
    case "case":
      return <TourCaseScreen />;
    case "diagnose":
      return <TourDiagnoseScreen />;
    case "monitor":
      return <TourMonitorScreen />;
  }
}

function TourStage({ tour }: { tour: EvaluateTourController }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<GhostCursorHandle>(null);
  const titleId = useId();
  const [screen, setScreen] = useState<StageScreen>("intro");
  const [stopIndex, setStopIndex] = useState<number | null>(null);
  const [typedName, setTypedName] = useState("");
  // The stop on screen or on its way in, for the skip event.
  const atStopRef = useRef<TourStopId | "intro">("intro");

  const stop = stopIndex === null ? null : TOUR_STOPS[stopIndex];
  const { rects, bounds } = useAnchorRects(rootRef, stop?.anchors ?? []);
  const { viewStop } = tour;
  const {
    play,
    cancel: cancelRun,
    reducedMotion,
  } = useTourPlayer(rootRef, cursorRef);

  useEffect(() => {
    if (stop && stopIndex !== null) viewStop(stop.id, stopIndex);
  }, [stop, stopIndex, viewStop]);

  const showStop = (index: number) => {
    const root = rootRef.current;
    const anchors = TOUR_STOPS[index]?.anchors ?? [];
    // Short panes clip the mock screens; bring the spotlighted parts into
    // view, the first one last so it wins when they don't all fit.
    for (const name of [...anchors].reverse()) {
      if (root) findAnchor(root, name)?.scrollIntoView?.({ block: "nearest" });
    }
    setStopIndex(index);
  };

  const start = (origin: HTMLElement) => {
    tour.begin();
    rootRef.current?.focus({ preventScroll: true });
    void play(origin, async (driver) => {
      await driver.click();
      setScreen("create");
      await driver.settle();
      await driver.pause(SCREEN_FADE_MS);
      await driver.moveTo("create-name");
      await driver.click();
      await driver.type(TOUR_EXAMPLE_SUITE_NAME, setTypedName);
      await driver.pause(250);
      await driver.moveTo("create-continue");
      await driver.click();
      setScreen("setup");
      atStopRef.current = "setup";
      await driver.settle();
      await driver.pause(SCREEN_FADE_MS);
      showStop(0);
    });
  };

  const next = (origin: HTMLElement) => {
    if (stop === null || stopIndex === null) return;
    const target = TOUR_STOPS[stopIndex + 1];
    if (!stop.advanceAnchor || !target) {
      cancelRun();
      tour.complete();
      return;
    }
    const advanceAnchor = stop.advanceAnchor;
    // The coachmark (and its focused button) unmounts; keep Escape working.
    rootRef.current?.focus({ preventScroll: true });
    setStopIndex(null);
    void play(origin, async (driver) => {
      await driver.pause(COACHMARK_FADE_MS);
      await driver.moveTo(advanceAnchor);
      await driver.click();
      setScreen(target.screen);
      atStopRef.current = target.id;
      await driver.settle();
      await driver.pause(SCREEN_FADE_MS);
      showStop(stopIndex + 1);
    });
  };

  const skip = () => {
    cancelRun();
    tour.skip(stop?.id ?? atStopRef.current);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    skip();
  };

  const screenFade = {
    duration: reducedMotion ? 0 : SCREEN_FADE_MS / 1000,
    ease: EASE_IN_OUT,
  };
  const coachmarkFade = {
    duration: reducedMotion ? 0 : COACHMARK_FADE_MS / 1000,
    ease: EASE_IN_OUT,
  };

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 z-40 overflow-hidden outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label="Evaluate tour"
      role="region"
      data-testid="evaluate-tour"
    >
      {/* Stays opaque while screens cross-fade so the real page never shows through. */}
      <AnimatePresence initial={!reducedMotion}>
        {screen === "intro" ? null : (
          <motion.div
            key="backdrop"
            aria-hidden
            className="absolute inset-0 bg-background"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={screenFade}
          />
        )}
      </AnimatePresence>
      <AnimatePresence initial={!reducedMotion}>
        {screen === "intro" ? (
          <motion.div
            key="intro"
            className="absolute inset-0 flex items-center justify-center bg-overlay/70"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={screenFade}
          >
            <TourIntroCard titleId={titleId} onStart={start} onSkip={skip} />
          </motion.div>
        ) : (
          <motion.div
            key={screen}
            inert
            className="absolute inset-0 bg-background"
            initial={{ opacity: 0, scale: 0.995 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={screenFade}
            data-testid={`evaluate-tour-screen-${screen}`}
          >
            <TourScreenView screen={screen} typedName={typedName} />
          </motion.div>
        )}
      </AnimatePresence>
      {screen === "intro" ? null : (
        <>
          <div className="absolute inset-0" aria-hidden />
          <AnimatePresence>
            {stop && stopIndex !== null ? (
              <motion.div
                key={stop.id}
                className="absolute inset-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={coachmarkFade}
              >
                <TourSpotlight rects={rects} />
                {rects[0] ? (
                  <TourCoachmark
                    anchor={rects[0]}
                    bounds={bounds}
                    placement={stop.placement}
                  >
                    <TourStepContent
                      labels={STOP_LABELS}
                      index={stopIndex}
                      title={stop.title}
                      body={stop.body}
                      onNext={next}
                      onSkip={skip}
                    />
                  </TourCoachmark>
                ) : null}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </>
      )}
      <TourGhostCursor ref={cursorRef} />
    </div>
  );
}
