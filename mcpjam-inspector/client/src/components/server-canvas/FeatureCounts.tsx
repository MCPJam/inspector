import type { FeatureStateCounts } from "@mcpjam/sdk/browser";
import { cn } from "@/lib/utils";
import {
  FEATURE_STATE_META,
  formatStateCounts,
  stateBarSegments,
} from "./feature-states";

/** "6 supported · 3 could add · 2 not checked": counts, never a score. */
export function FeatureCountsText({
  counts,
  className,
}: {
  counts: FeatureStateCounts;
  className?: string;
}) {
  const text = formatStateCounts(counts);
  if (!text) return null;
  return (
    <span className={cn("text-xs text-muted-foreground", className)}>
      {text}
    </span>
  );
}

/**
 * A thin bar split by the same counts. The text beside it carries the
 * numbers, so the bar itself is hidden from assistive technology.
 */
export function FeatureCountsBar({
  counts,
  className,
}: {
  counts: FeatureStateCounts;
  className?: string;
}) {
  const segments = stateBarSegments(counts);
  return (
    <div
      aria-hidden
      data-testid="feature-counts-bar"
      className={cn(
        "flex h-1 w-full gap-px overflow-hidden rounded-full bg-muted",
        className,
      )}
    >
      {segments.map((segment) => (
        <span
          key={segment.state}
          data-state={segment.state}
          className={cn("h-full", FEATURE_STATE_META[segment.state].barClass)}
          style={{ width: `${segment.percent}%` }}
        />
      ))}
    </div>
  );
}
