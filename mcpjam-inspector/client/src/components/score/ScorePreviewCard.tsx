import { useEffect, useRef, useState } from "react";
import { ScoreCard } from "./score-card";
import { ScorePlane } from "./ScorePlane";
import { SCORE_PREVIEW_DIMENSIONS } from "./score-runner-view-model";

const PREVIEW_SCORES = ["75", "77", "100", "100", "88"] as const;
const PREVIEW_STATUSES = [
  "MIXED",
  "INCOMPLETE",
  "PASSED",
  "PASSED",
  "REVIEW",
] as const;

/**
 * The Paper mock's 432px bar, kept as proportions rather than pixel widths:
 * the card narrows on mobile, where fixed widths pushed the trailing
 * segments past the `overflow-hidden` edge.
 */
const PREVIEW_BAR_SEGMENTS = [
  { colorClass: "bg-[#3D8A5A]", share: 241 },
  { colorClass: "bg-[#C45A3A]", share: 31 },
  { colorClass: "bg-[#C49A4A]", share: 27 },
  { colorClass: "bg-[var(--score-border)]", share: 103 },
  { colorClass: "bg-[#1A1918]", share: 30 },
] as const;

const PREVIEW_ROWS = SCORE_PREVIEW_DIMENSIONS.map((label, index) => ({
  label,
  score: PREVIEW_SCORES[index] ?? "",
  status: PREVIEW_STATUSES[index] ?? "",
  emphasize: PREVIEW_STATUSES[index] !== "PASSED",
}));

export type ScorePreviewStage = "card" | "gone";

const COLLAPSE_MS = 240;
const FOLD_MS = 280;
const ANTICIPATE_MS = 120;
const LAUNCH_MS = 700;
const DEPART_MS = COLLAPSE_MS + FOLD_MS + ANTICIPATE_MS + LAUNCH_MS;

const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
const POWER2_IN = "cubic-bezier(0.55, 0.06, 0.68, 0.19)";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function usePreviewVisual(stage: ScorePreviewStage) {
  const [visual, setVisual] = useState<ScorePreviewStage | "departing">(stage);
  const previous = useRef(stage);

  useEffect(() => {
    if (previous.current === "card" && stage === "gone") {
      if (prefersReducedMotion()) {
        previous.current = stage;
        setVisual("gone");
        return;
      }
      setVisual("departing");
      const timer = window.setTimeout(() => {
        setVisual("gone");
      }, DEPART_MS);
      previous.current = stage;
      return () => window.clearTimeout(timer);
    }

    previous.current = stage;
    setVisual(stage);
  }, [stage]);

  return visual;
}

async function playSendOff(
  plane: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  if (typeof plane.animate !== "function") return;

  const run = (
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ): Promise<void> => {
    const animation = plane.animate(keyframes, { ...options, fill: "forwards" });
    const abort = () => animation.cancel();
    signal.addEventListener("abort", abort, { once: true });
    return animation.finished.then(() => undefined).catch(() => undefined);
  };

  await run(
    [
      {
        opacity: 0,
        transform: "translate(-50%, -50%) scale(0.22) rotate(-10deg)",
      },
      {
        opacity: 1,
        transform: "translate(-50%, -50%) scale(1) rotate(0deg)",
      },
    ],
    { delay: COLLAPSE_MS, duration: FOLD_MS, easing: EASE_OUT },
  );
  if (signal.aborted) return;

  await run(
    [
      { transform: "translate(-50%, -50%) scale(1) rotate(0deg)" },
      {
        transform:
          "translate(calc(-50% - 16px), calc(-50% + 12px)) scale(0.94) rotate(-12deg)",
      },
    ],
    { duration: ANTICIPATE_MS, easing: EASE_OUT },
  );
  if (signal.aborted) return;

  await run(
    [
      {
        offset: 0,
        opacity: 1,
        transform:
          "translate(calc(-50% - 16px), calc(-50% + 12px)) scale(0.94) rotate(-12deg)",
      },
      {
        offset: 0.28,
        opacity: 1,
        transform:
          "translate(calc(-50% + 6vw), calc(-50% - 16vh)) scale(0.88) rotate(4deg)",
      },
      {
        offset: 0.58,
        opacity: 1,
        transform:
          "translate(calc(-50% + 20vw), calc(-50% - 30vh)) scale(0.78) rotate(18deg)",
      },
      {
        offset: 0.82,
        opacity: 1,
        transform:
          "translate(calc(-50% + 38vw), calc(-50% - 36vh)) scale(0.68) rotate(28deg)",
      },
      {
        offset: 1,
        opacity: 0,
        transform:
          "translate(calc(-50% + 54vw), calc(-50% - 40vh)) scale(0.58) rotate(34deg)",
      },
    ],
    { duration: LAUNCH_MS, easing: POWER2_IN },
  );
}

export function ScorePreviewCard({
  compact = false,
  stage = "card",
}: {
  compact?: boolean;
  stage?: ScorePreviewStage;
}) {
  const visual = usePreviewVisual(stage);
  const planeRef = useRef<HTMLDivElement>(null);
  const showCard = visual === "card" || visual === "departing";

  useEffect(() => {
    if (visual !== "departing" || !planeRef.current) return;
    const controller = new AbortController();
    void playSendOff(planeRef.current, controller.signal);
    return () => controller.abort();
  }, [visual]);

  return (
    <aside
      aria-hidden="true"
      data-stage={visual}
      className="score-preview-card relative w-full xl:w-[480px] xl:shrink-0"
    >
      {showCard && (
        <div
          className={
            visual === "departing" ? "score-preview-card-fold" : undefined
          }
        >
          <ScoreCard
            kicker="Overall score"
            server="mcp.monday.com"
            score="84"
            rows={PREVIEW_ROWS}
            segments={PREVIEW_BAR_SEGMENTS}
            footer="113 checks. 63 passed, 8 failed, 27 not applicable."
            compact={compact}
            departing={visual === "departing"}
          />
        </div>
      )}
      {visual === "departing" && (
        <div
          ref={planeRef}
          data-testid="score-preview-plane"
          className="score-preview-plane pointer-events-none absolute left-1/2 top-1/2 h-[70%] opacity-0"
        >
          <ScorePlane className="h-full w-auto" />
        </div>
      )}
    </aside>
  );
}
