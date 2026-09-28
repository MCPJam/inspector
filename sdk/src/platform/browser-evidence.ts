import type {
  PlatformBrowserScreenshot,
  PlatformChatSessionTrace,
} from "./types.js";

/** Stable URLs only; missing captures are not downloadable evidence. */
export function collectSessionScreenshots(
  trace: PlatformChatSessionTrace,
  options: { limit?: number; failedOnly?: boolean } = {}
): PlatformBrowserScreenshot[] {
  const limit =
    options.limit === undefined
      ? 100
      : Math.max(0, Math.min(100, Math.floor(options.limit)));
  const found: PlatformBrowserScreenshot[] = [];
  const seen = new Set<string>();
  for (const turn of trace.turns)
    for (const shot of turn.screenshots ?? []) {
      if (!shot.url) continue;
      const failed =
        turn.finishReason === "error" ||
        turn.finishReason === "timeout" ||
        turn.spans?.some((raw) => {
          const span = raw as {
            toolCallId?: string;
            status?: string;
            error?: unknown;
          };
          return (
            span.toolCallId === shot.toolCallId &&
            (span.status === "error" || !!span.error)
          );
        });
      if (options.failedOnly && !failed) continue;
      const key = `${turn.turnId}:${shot.toolCallId}:${shot.stepIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (found.length < limit) found.push({ ...shot, turnId: turn.turnId });
    }
  return found;
}
