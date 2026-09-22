import type { RebuildResult } from "@/hooks/useUsageInsights";
export type RebuildFeedback = { tone: "success" | "info"; message: string };
export function rebuildFeedback(result: RebuildResult): RebuildFeedback {
  return result.alreadyRunning
    ? { tone: "info", message: "Analysis is already running" }
    : { tone: "success", message: "Session analysis queued" };
}
