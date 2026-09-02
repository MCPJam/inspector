/**
 * The verdict, the sentence, the action — then the numbers.
 *
 * Reading order IS the design here. The old page opened with a 67% and four
 * metric tiles, so the first thing a reader met was an arithmetic summary of a
 * run whose one interesting fact (a case broke, here, for this reason) was
 * three panels down behind a "Show more". This block inverts that: decision,
 * then the failing case in one sentence, then what to do about it, and the
 * measurements last and small.
 *
 * Every string comes from {@link buildRunVerdictHero}. The view chooses type
 * and colour; it never decides what is true.
 */
import { ArrowUpRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";

import { formatRunCaseLatencyMs } from "../evals/run-case-groups";
import type {
  HeroVerdictTone,
  RunVerdictHeroView,
} from "./run-verdict-hero-model";

const VERDICT_TONE_CLASS: Record<HeroVerdictTone, string> = {
  passed: "text-success",
  failed: "text-destructive",
  // Amber. An inconclusive run measured too little to decide, and red would
  // report a defect the run never observed.
  caution: "text-amber-600 dark:text-amber-500",
  neutral: "text-muted-foreground",
};

function formatCount(value: number | null): string {
  if (value === null) return "not recorded";
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`;
  }
  return String(value);
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0 px-4 py-2 first:pl-0">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-foreground">
        {value}
      </div>
      {detail ? (
        <div className="text-[11.5px] text-muted-foreground">{detail}</div>
      ) : null}
    </div>
  );
}

function caseStatText(view: RunVerdictHeroView): {
  value: string;
  detail: string;
} {
  const { cases, iterations } = view.stats;
  if (cases.kind === "cases") {
    return {
      value: `${cases.passed} of ${cases.total}`,
      detail:
        cases.inconclusive > 0
          ? `cases · ${cases.inconclusive} inconclusive`
          : "cases",
    };
  }
  if (cases.kind === "trials") {
    if (cases.passed === null || cases.total === null) {
      // Absent stays absent. A run that recorded no total has not recorded a
      // total of zero, and "0 of 0" would be a claim it never made.
      return { value: "not recorded", detail: "iterations" };
    }
    return {
      value: `${cases.passed} of ${cases.total}`,
      detail: "iterations, not cases",
    };
  }
  return {
    value: `${iterations.passed} of ${iterations.total}`,
    detail: "iterations on this page",
  };
}

export function RunVerdictHero({
  view,
  onOpenFailingTrace,
  actions,
}: {
  view: RunVerdictHeroView;
  onOpenFailingTrace?: () => void;
  /** The primary action slot, so the copy-prompt button can land here later. */
  actions?: React.ReactNode;
}) {
  const caseStat = caseStatText(view);
  const hasSentence = view.sentence.text.length > 0;
  const canOpenTrace = Boolean(onOpenFailingTrace && view.focus);

  return (
    <section
      className="flex flex-col gap-5 px-5 py-5 lg:flex-row lg:items-start lg:justify-between lg:gap-10"
      data-testid="run-verdict-hero"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3
            className={cn(
              "text-[30px] font-bold leading-none tracking-tight",
              VERDICT_TONE_CLASS[view.verdict.tone],
            )}
            data-testid="run-verdict-word"
          >
            {view.verdict.word}
          </h3>
          {view.verdict.undecidedLine ? (
            <span className="text-[12.5px] text-muted-foreground">
              {view.verdict.undecidedLine}
            </span>
          ) : null}
        </div>

        {hasSentence ? (
          <p
            className="mt-3 max-w-[56ch] text-[15px] leading-relaxed text-foreground"
            data-testid="run-verdict-sentence"
          >
            {view.sentence.text}
          </p>
        ) : null}

        {view.sentence.kind === "brokeAt" &&
        (view.sentence.expected.length > 0 ||
          view.sentence.observed.length > 0) ? (
          <dl className="mt-2.5 flex flex-wrap gap-x-6 gap-y-1 text-[12.5px]">
            {view.sentence.expected.length > 0 ? (
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">Expected</dt>
                <dd className="font-mono text-foreground">
                  {view.sentence.expected.join(", ")}
                </dd>
              </div>
            ) : null}
            {view.sentence.observed.length > 0 ? (
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">Observed</dt>
                <dd className="font-mono text-foreground">
                  {view.sentence.observed.join(", ")}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {actions || canOpenTrace ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {actions}
            {canOpenTrace ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={onOpenFailingTrace}
                data-testid="run-verdict-open-trace"
              >
                Open failing trace
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap divide-x divide-border/40 lg:border-l lg:border-border/40 lg:pl-2">
        <Stat label="Passed" value={caseStat.value} detail={caseStat.detail} />
        <Stat
          label="Latency p50"
          value={formatRunCaseLatencyMs(view.stats.latencyP50Ms)}
          detail={`p95 ${formatRunCaseLatencyMs(view.stats.latencyP95Ms)}`}
        />
        <Stat label="Tokens" value={formatCount(view.stats.tokens)} />
        <Stat label="Tool calls" value={formatCount(view.stats.toolCalls)} />
      </div>
    </section>
  );
}
