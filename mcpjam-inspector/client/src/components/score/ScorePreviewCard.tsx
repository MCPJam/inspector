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

export type ScorePreviewStage = "card" | "plane";

function usePreviewVisual(stage: ScorePreviewStage) {
  const [visual, setVisual] = useState<ScorePreviewStage>(stage);
  const [departing, setDeparting] = useState(false);
  const previous = useRef(stage);

  useEffect(() => {
    if (previous.current === "card" && stage === "plane") {
      setDeparting(true);
      const timer = window.setTimeout(() => {
        setDeparting(false);
        setVisual("plane");
      }, 720);
      previous.current = stage;
      return () => window.clearTimeout(timer);
    }

    previous.current = stage;
    setVisual(stage);
    setDeparting(false);
  }, [stage]);

  if (departing) return "departing" as const;
  return visual;
}

export function ScorePreviewCard({
  compact = false,
  stage = "card",
}: {
  compact?: boolean;
  stage?: ScorePreviewStage;
}) {
  const visual = usePreviewVisual(stage);
  const showCard = visual === "card" || visual === "departing";

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
            kicker="Overall · run 2026-08-26"
            server="mcp.monday.com"
            score="84"
            rows={PREVIEW_ROWS}
            segments={PREVIEW_BAR_SEGMENTS}
            footer="113 checks. 63 passed, 8 failed."
            compact={compact}
          />
        </div>
      )}
      {visual === "departing" && (
        <div
          data-testid="score-preview-plane"
          className="score-preview-plane score-preview-plane--launch pointer-events-none absolute left-1/2 top-1/2 h-[220px] w-[220px]"
        >
          <ScorePlane className="h-full w-full" />
        </div>
      )}
      {visual === "plane" && (
        <div
          data-testid="score-preview-plane"
          className="score-preview-plane score-preview-plane--parked flex h-[405px] items-center justify-center"
        >
          <ScorePlane className="h-[220px] w-[220px]" />
        </div>
      )}
    </aside>
  );
}
