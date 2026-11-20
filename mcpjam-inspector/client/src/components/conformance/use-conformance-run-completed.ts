import { useEffect, useRef } from "react";
import type { ConformanceScore } from "@mcpjam/sdk/browser";
import { track } from "@/lib/analytics";
import { requestGitHubStarPrompt } from "@/lib/github-star-prompt";

/**
 * Reports each run this page started and saw finish, and asks for a GitHub
 * star after one that produced a score, passed or failed. A saved run opened later never counts.
 */
export function useConformanceRunCompleted(
  isRunning: boolean,
  score: ConformanceScore | undefined,
): void {
  const wasRunning = useRef(isRunning);
  useEffect(() => {
    const finished = wasRunning.current && !isRunning;
    wasRunning.current = isRunning;
    if (!finished || !score) return;
    const hasAdvice = score.advisories.length > 0;
    track("conformance_run_completed", {
      location: "conformance_tab",
      run_source: "ui",
      outcome: score.outcome,
      has_advice: hasAdvice,
      scored: score.score !== null,
    });
    // Incomplete runs and runs where nothing applied have no result to show for.
    if (score.outcome !== "incomplete" && score.score !== null) {
      requestGitHubStarPrompt({
        trigger: "conformance",
        reason: "completed",
        hasAdvice,
      });
    }
  }, [isRunning, score]);
}
