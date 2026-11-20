import { useEffect, useRef } from "react";
import type { ConformanceScore } from "@mcpjam/sdk/browser";
import { track } from "@/lib/analytics";
import { requestGitHubStarPrompt } from "@/lib/github-star-prompt";

/**
 * Reports each run this page started and saw finish, and asks for a GitHub
 * star after a passing one. A saved run opened later never counts.
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
    });
    // A run where nothing applied passes vacuously; it is no success to celebrate.
    if (score.outcome === "passed" && score.score !== null) {
      requestGitHubStarPrompt({
        trigger: "conformance",
        reason: "completed",
        hasAdvice,
      });
    }
  }, [isRunning, score]);
}
