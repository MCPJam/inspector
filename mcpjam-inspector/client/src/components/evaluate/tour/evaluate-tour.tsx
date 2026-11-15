import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  TOUR_EXAMPLE_SUITE_NAME,
  TOUR_STOPS,
  type TourScreen,
  type TourStopId,
} from "./evaluate-tour-steps";
import type { EvaluateTourController } from "./use-evaluate-tour";
import {
  TourCancelled,
  createTourDriver,
  type TourDriver,
  type TourRun,
} from "./tour-driver";
import { TourGhostCursor, type GhostCursorHandle } from "./tour-ghost-cursor";
import { rectCenter, rectWithin, useAnchorRects } from "./tour-geometry";
import { TourSpotlight } from "./tour-spotlight";
import { StopCoachmarkContent, TourPopover } from "./tour-popover";
import { TourIntroCard } from "./tour-intro";
import { TourHandoff } from "./tour-handoff";
import { TourCreateScreen, TourSetupScreen } from "./tour-screens-setup";
import { TourDiagnoseScreen, TourExperimentScreen } from "./tour-screens-case";
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
    case "experiment":
      return <TourExperimentScreen />;
    case "diagnose":
      return <TourDiagnoseScreen />;
    case "monitor":
      return <TourMonitorScreen />;
  }
}

function TourStage({ tour }: { tour: EvaluateTourController }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<GhostCursorHandle>(null);
  // The transition in flight. Each one gets its own token, so cancelling
  // one (skip, unmount, StrictMode's dev remount) never poisons the next.
  const runRef = useRef<TourRun | null>(null);
  const reducedMotion = useReducedMotion() ?? false;
  const titleId = useId();
  const [screen, setScreen] = useState<StageScreen>("intro");
  const [stopIndex, setStopIndex] = useState<number | null>(null);
  const [typedName, setTypedName] = useState("");

  const stop = stopIndex === null ? null : TOUR_STOPS[stopIndex];
  const { rects, bounds } = useAnchorRects(rootRef, stop?.anchors ?? []);
  const { viewStop } = tour;

  const cancelRun = useCallback(() => {
    if (runRef.current) runRef.current.cancelled = true;
    runRef.current = null;
  }, []);

  useEffect(() => cancelRun, [cancelRun]);

  useEffect(() => {
    if (stop && stopIndex !== null) viewStop(stop.id, stopIndex);
  }, [stop, stopIndex, viewStop]);

  const play = useCallback(
    async (
      origin: HTMLElement,
      script: (driver: TourDriver) => Promise<void>,
    ) => {
      const root = rootRef.current;
      const cursor = cursorRef.current;
      if (!root || !cursor) return;
      cancelRun();
      const run: TourRun = { cancelled: false };
      runRef.current = run;
      const driver = createTourDriver({ root, cursor, run, reducedMotion });
      if (!reducedMotion) cursor.show(rectCenter(rectWithin(root, origin)));
      try {
        await script(driver);
      } catch (error) {
        if (!(error instanceof TourCancelled)) throw error;
        // The tour closed mid-transition; the overlay is already gone.
      } finally {
        cursor.hide();
      }
    },
    [reducedMotion, cancelRun],
  );

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
      await driver.settle();
      await driver.pause(SCREEN_FADE_MS);
      setStopIndex(0);
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
      setScreen(target.id);
      await driver.settle();
      await driver.pause(SCREEN_FADE_MS);
      setStopIndex(stopIndex + 1);
    });
  };

  const skip = () => {
    cancelRun();
    const at: TourStopId | "intro" =
      stop?.id ??
      (screen === "intro" || screen === "create" ? "intro" : screen);
    tour.skip(at);
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
                  <TourPopover
                    anchor={rects[0]}
                    bounds={bounds}
                    placement={stop.placement}
                    labelledBy={titleId}
                  >
                    <StopCoachmarkContent
                      stop={stop}
                      index={stopIndex}
                      titleId={titleId}
                      onNext={next}
                      onSkip={skip}
                    />
                  </TourPopover>
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
