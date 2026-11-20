import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Variants,
} from "framer-motion";

const EASE_OUT = [0, 0, 0.2, 1] as const;
/** Step 1's status area eases to its new height over this long. */
const SWAP_MS = 220;
/** The checklist collapses, then today's Home rises, each this long. */
const HANDOFF_MS = 280;
/** Before growing on return, so the bar paints at the old count first. */
const RETURN_GROW_DELAY_MS = 150;

/**
 * Swaps Step 1's status (connecting, connected, failed) while the area eases
 * to its new height, so the panel doesn't jump. The new content fades in once
 * most of the height is there, so it isn't revealed half at a time.
 */
export function StatusSwap({
  swapKey,
  children,
}: {
  swapKey: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  const [clip, setClip] = useState(false);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  if (reduce) return <div className="space-y-4">{children}</div>;
  return (
    <motion.div
      initial={false}
      animate={{ height }}
      transition={{ duration: SWAP_MS / 1000, ease: EASE_OUT }}
      onAnimationStart={() => setClip(true)}
      onAnimationComplete={() => setClip(false)}
      className={clip ? "overflow-hidden" : undefined}
    >
      <div ref={inner}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={swapKey}
            className="space-y-4"
            initial={{ opacity: 0 }}
            animate={{
              opacity: 1,
              transition: { duration: 0.14, delay: 0.08, ease: EASE_OUT },
            }}
            exit={{
              opacity: 0,
              pointerEvents: "none",
              transition: { duration: 0.06, ease: EASE_OUT },
            }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

/**
 * The done count for the progress bar. Coming back to Home after finishing a
 * step elsewhere, it starts at the count Home last showed and then catches up,
 * so the bar grows instead of already being full.
 */
export function useProgressFromLastVisit(
  count: number,
  ready: boolean,
  lastShown: number | undefined,
  save: (count: number) => void,
): number {
  const from = useRef<number | null>(null);
  if (ready && from.current === null) {
    from.current = Math.min(lastShown ?? count, count);
  }
  const behind = from.current !== null && from.current < count;
  const [caughtUp, setCaughtUp] = useState(false);
  useEffect(() => {
    if (!ready || caughtUp) return;
    if (!behind) {
      setCaughtUp(true);
      return;
    }
    const timer = window.setTimeout(
      () => setCaughtUp(true),
      RETURN_GROW_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [ready, caughtUp, behind]);
  useEffect(() => {
    if (caughtUp && lastShown !== count) save(count);
  }, [caughtUp, lastShown, count, save]);
  return caughtUp ? count : (from.current ?? count);
}

type HandoffPhase = "checklist" | "collapsing" | "rising" | "home";

/**
 * Home's switch from the checklist back to today's Home. A checklist that was
 * on screen collapses, then today's Home rises in; any other switch (arriving
 * finished, an error, reduced motion) is instant.
 */
export function useChecklistHandoff() {
  const reduce = useReducedMotion() ?? false;
  const [phase, setPhase] = useState<HandoffPhase>("checklist");
  const finish = useCallback(
    (shown: boolean) =>
      setPhase((current) =>
        current !== "checklist"
          ? current
          : shown && !reduce
            ? "collapsing"
            : "home",
      ),
    [reduce],
  );
  const finishNow = useCallback(() => finish(false), [finish]);
  const onExitComplete = useCallback(
    () =>
      setPhase((current) => (current === "collapsing" ? "rising" : current)),
    [],
  );
  return {
    phase,
    finished: phase !== "checklist",
    /** Today's Home waits for the checklist to finish collapsing. */
    homeVisible: phase !== "collapsing",
    rising: phase === "rising",
    finish,
    finishNow,
    onExitComplete,
  };
}

const checklistVariants: Variants = {
  shown: { opacity: 1, height: "auto", scale: 1 },
  gone: {
    opacity: 0,
    height: 0,
    scale: 0.98,
    overflow: "hidden",
    pointerEvents: "none",
    transition: { duration: HANDOFF_MS / 1000, ease: EASE_OUT },
  },
};

export function ChecklistPresence({
  handoff,
  children,
}: {
  handoff: ReturnType<typeof useChecklistHandoff>;
  children: ReactNode;
}) {
  // Only a collapse keeps the checklist around after it's gone.
  if (!children && handoff.phase !== "collapsing") return null;
  return (
    <AnimatePresence initial={false} onExitComplete={handoff.onExitComplete}>
      {children ? (
        <motion.div
          key="checklist"
          variants={checklistVariants}
          initial="shown"
          animate="shown"
          exit="gone"
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Today's Home content; rises in 6 px when the checklist just handed back. */
export function Rise({
  active,
  className,
  children,
}: {
  active: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <motion.div
      initial={active ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: HANDOFF_MS / 1000, ease: EASE_OUT }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
