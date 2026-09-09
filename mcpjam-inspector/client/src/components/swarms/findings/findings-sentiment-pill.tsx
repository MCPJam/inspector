/**
 * Sentiment renders as a colored PILL ONLY — never a card wash. The tone
 * palette mirrors the status chips in `run-insights.tsx` so the Findings tab
 * speaks the app's existing severity language.
 */

import { cn } from "@/lib/utils";
import type { SentimentPillModel, SentimentTone } from "./findings-derivation";

// Role tokens only — literal hex/oklch() in a component is forbidden by
// AGENTS.md and would not track the theme (design:lint gates CI).
const TONE_CLASSES: Record<SentimentTone, string> = {
  fail: "border-destructive/40 bg-destructive/10 text-destructive",
  warn: "border-warning/40 bg-warning/10 text-warning",
  ok: "border-success/40 bg-success/10 text-success",
  muted: "border-border bg-muted/40 text-muted-foreground",
};

export function SentimentPill({
  sentiment,
  className,
}: {
  sentiment: SentimentPillModel;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-[7px] py-0.5 text-[10px] font-bold uppercase tracking-[0.1em]",
        TONE_CLASSES[sentiment.tone],
        className
      )}
      data-testid="findings-sentiment-pill"
      data-tone={sentiment.tone}
    >
      {sentiment.label}
    </span>
  );
}
