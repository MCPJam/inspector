import type { RebuildResult } from "@/hooks/useUsageInsights";

export type RebuildFeedback = {
  tone: "success" | "info" | "warning";
  message: string;
};

/**
 * What to tell the user after queueing a rebuild.
 *
 * Three outcomes, not two. The one worth the extra branch is the third: a
 * rebuild was already in flight AND it was queued with different settings, so
 * the settings just chosen were dropped. Reporting that as "a rebuild is
 * already running" is technically true and actively misleading — the user
 * would watch it finish and conclude the knobs do nothing.
 *
 * Shared by both insights panels so the wording of that case cannot drift
 * between the chatbox surface and the swarm one.
 */
export function rebuildFeedback(result: RebuildResult): RebuildFeedback {
  if (!result.alreadyRunning) {
    return { tone: "success", message: "Rebuild queued" };
  }
  if (result.tuningMismatch) {
    return {
      tone: "warning",
      message:
        "A rebuild with different settings is already running — your changes were not applied. Try again once it finishes.",
    };
  }
  return { tone: "info", message: "A rebuild is already running" };
}
