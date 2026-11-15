import { Check, Minus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { STAGE_CHIP_TONE_CLASS } from "@/components/evaluate/stage-chain-model";

export type Outcome = "passed" | "failed" | "not_applicable";

const OUTCOME = {
  passed: { label: "Pass", icon: Check, tone: STAGE_CHIP_TONE_CLASS.passed },
  failed: { label: "Fail", icon: X, tone: STAGE_CHIP_TONE_CLASS.failed },
  not_applicable: {
    label: "N/A",
    icon: Minus,
    tone: STAGE_CHIP_TONE_CLASS.unmeasured,
  },
} as const;

/**
 * A compact pass, fail or not-applicable label for the library's authoring
 * surfaces. Not applicable is outlined and neutral so it never reads as a
 * pass. Each state carries an icon and a word, not only a color.
 */
export function OutcomeTag({
  outcome,
  label,
}: {
  outcome: Outcome;
  /** Overrides the default word, e.g. a score such as "1.0". */
  label?: string;
}) {
  const { icon: Icon, tone, label: fallback } = OUTCOME[outcome];
  return (
    <span
      data-outcome={outcome}
      className={cn(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-sm px-1.5 text-[11px] font-semibold uppercase tracking-wide",
        tone,
        outcome === "passed" && "bg-success/15",
        outcome === "failed" && "bg-destructive/10",
        outcome === "not_applicable" && "border border-border",
      )}
    >
      <Icon aria-hidden className="size-3" />
      {label ?? fallback}
    </span>
  );
}
