/**
 * Sentiment renders as a colored PILL ONLY — never a card wash. The tone
 * palette mirrors the status chips in `run-insights.tsx` so the Findings tab
 * speaks the app's existing severity language.
 */

import { cn } from "@/lib/utils";
import type { SentimentPillModel, SentimentTone } from "./findings-derivation";

const TONE_CLASSES: Record<SentimentTone, string> = {
  fail: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
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
        "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.11em]",
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
