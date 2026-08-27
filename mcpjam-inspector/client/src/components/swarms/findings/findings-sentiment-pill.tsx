/**
 * Sentiment renders as a colored PILL ONLY — never a card wash. The tone
 * palette mirrors the status chips in `run-insights.tsx` so the Findings tab
 * speaks the app's existing severity language.
 */

import { cn } from "@/lib/utils";
import type { SentimentPillModel, SentimentTone } from "./findings-derivation";

const TONE_CLASSES: Record<SentimentTone, string> = {
  fail: "border-[#FBB7B0] bg-[oklch(94%_0.04_25)] text-[#AC1922] dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-400",
  warn: "border-[#EACF83] bg-[#FEF2C5] text-[oklch(45%_0.1_85)] dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400",
  ok: "border-[#9DD4AB] bg-[#D3F5DB] text-[oklch(40%_0.11_152)] dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-400",
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
