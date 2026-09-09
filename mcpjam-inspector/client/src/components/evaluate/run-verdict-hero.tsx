/**
 * Pairing pass/fail bars, the sentence, the action — then the page measurements.
 *
 * Reading order IS the design here. Pass/fail is a per-client decision, so it
 * sits with the pairing — logo, name, bar, and key — not as one rolled-up
 * PASSED tile. Insights follow. Latency, tokens, and tool calls stay a
 * page-level strip at the bottom.
 *
 * Every string comes from {@link buildRunVerdictHero}. The view chooses type
 * and colour; it never decides what is true.
 */
import { useRunHeaderVerdict } from "./evaluate-run-page";
import { remedyForDiagnostic } from "./stage-remedy";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  Lightbulb,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { usePreferencesStoreWithDefaults } from "@/stores/preferences/preferences-provider";

import { formatRunCaseLatencyMs } from "../evals/run-case-groups";
import {
  formatHeroCount,
  type HeroPairingPass,
  type HeroStatDelta,
} from "./run-verdict-hero-deltas";
import { ResultCountBar, ResultCountKey } from "./result-count-bar";
import type {
  HeroVerdictTone,
  RunVerdictHeroView,
} from "./run-verdict-hero-model";

const VERDICT_TONE_CLASS: Record<HeroVerdictTone, string> = {
  passed: "text-success",
  failed: "text-destructive",
  // Amber. An inconclusive run measured too little to decide, and red would
  // report a defect the run never observed.
  caution: "text-warning",
  neutral: "text-muted-foreground",
};

function formatCount(value: number | null): string {
  if (value === null) return "not recorded";
  return formatHeroCount(value);
}

const DELTA_TONE_CLASS = {
  progress: "text-success",
  regression: "text-destructive",
  same: "text-muted-foreground",
} as const;

function StatDelta({ delta }: { delta: HeroStatDelta }) {
  const Arrow =
    delta.direction === "up"
      ? ArrowUp
      : delta.direction === "down"
        ? ArrowDown
        : null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[11.5px] font-medium tabular-nums",
        DELTA_TONE_CLASS[delta.tone],
      )}
      aria-label={`${delta.label} vs previous run`}
      data-testid="run-verdict-stat-delta"
    >
      {Arrow ? <Arrow className="size-3" aria-hidden /> : null}
      {delta.label}
    </span>
  );
}

function Stat({
  label,
  value,
  detail,
  delta,
}: {
  label: string;
  value: string;
  detail?: string;
  delta?: HeroStatDelta | null;
}) {
  return (
    <div className="min-w-0 px-4 py-2 first:pl-0">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
        <div className="text-[15px] font-semibold tabular-nums text-foreground">
          {value}
        </div>
        {delta ? <StatDelta delta={delta} /> : null}
      </div>
      {detail ? (
        <div className="text-[11.5px] text-muted-foreground">{detail}</div>
      ) : null}
    </div>
  );
}

function AiGeneratedLabel() {
  return (
    <span
      className="shrink-0 text-[10.5px] font-medium text-muted-foreground"
      data-testid="run-verdict-ai-insight"
    >
      AI generated
    </span>
  );
}

function PairingPassList({ pairings }: { pairings: HeroPairingPass[] }) {
  const theme = usePreferencesStoreWithDefaults((state) => state.themeMode);
  return (
    <ul
      className="divide-y divide-border/60"
      data-testid="run-verdict-pairings"
    >
      {pairings.map((pairing) => {
        const counts = {
          passed: pairing.passed,
          failed: pairing.failed,
          pending: pairing.pending,
          cancelled: pairing.cancelled,
        };
        const showDelta =
          pairing.delta != null && pairing.delta.direction !== "same";
        return (
          <li
            key={pairing.key}
            className="flex min-w-0 items-center gap-4 py-4"
            data-testid="run-verdict-pairing"
          >
            <div className="flex w-44 shrink-0 items-center gap-2">
              <img
                src={resolveHostLogoByName(pairing.client, theme)}
                alt=""
                className="size-4 shrink-0 object-contain"
              />
              <span className="min-w-0 truncate text-[13px] leading-none">
                <span className="font-medium text-foreground">
                  {pairing.client}
                </span>
                <span className="text-muted-foreground"> · {pairing.model}</span>
              </span>
            </div>
            <div className="flex w-40 shrink-0 items-center gap-2">
              <ResultCountKey counts={counts} />
              {showDelta && pairing.delta ? (
                <StatDelta delta={pairing.delta} />
              ) : null}
            </div>
            <ResultCountBar counts={counts} className="min-w-0 flex-1" />
          </li>
        );
      })}
    </ul>
  );
}

export function RunVerdictHero({
  view,
  headerVerdict = view.verdict,
  onOpenFailingTrace,
  actions,
}: {
  view: RunVerdictHeroView;
  headerVerdict?: RunVerdictHeroView["verdict"];
  onOpenFailingTrace?: () => void;
  /** The primary action slot, so the copy-prompt button can land here later. */
  actions?: React.ReactNode;
}) {
  const inHeader = useRunHeaderVerdict(headerVerdict);
  const showVerdict = !inHeader && view.verdict.word !== "Running";
  const pairings = view.pairings ?? [];
  const hasPairings = pairings.length > 0;
  const remedy = view.focus ? remedyForDiagnostic(view.focus.diagnostic) : null;
  const hasSentence = view.sentence.text.trim().length > 0;
  const summaryLoading =
    view.pending ||
    (!hasSentence &&
      ["Running", "Pending", "Queued"].includes(view.verdict.word));
  const canOpenTrace = Boolean(onOpenFailingTrace && view.focus);

  return (
    <section
      className="flex flex-col gap-5 px-5 py-4"
      data-testid="run-verdict-hero"
    >
      <div className="min-w-0 flex-1">
        {showVerdict ? (
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
        ) : null}

        {hasPairings ? (
          <div className={cn(showVerdict && "mt-4")}>
            <PairingPassList pairings={pairings} />
          </div>
        ) : null}

        {summaryLoading ? (
          <div
            className="grid divide-y divide-border/40 border-t border-border/60 pt-3 lg:grid-cols-2 lg:divide-x lg:divide-y-0"
            role="status"
            aria-label="Loading run summary"
            data-testid="run-summary-loading"
          >
            {[0, 1].map((column) => (
              <div
                key={column}
                className="min-w-0 space-y-3 py-3 lg:px-4 lg:py-2 lg:first:pl-0"
                aria-hidden="true"
              >
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            ))}
          </div>
        ) : hasSentence ? (
          <div
            className="grid divide-y divide-border/40 border-t border-border/60 pt-3 lg:grid-cols-2 lg:divide-x lg:divide-y-0"
            data-testid="run-verdict-insights"
          >
            <div className="min-w-0 py-3 lg:px-4 lg:py-2 lg:first:pl-0">
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                  {view.sentence.kind === "noFailure" ? (
                    <CircleCheck
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                  ) : view.sentence.kind === "brokeAt" ? (
                    <TriangleAlert
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                  ) : (
                    <CircleAlert
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                  )}
                  {view.sentence.kind === "noFailure"
                    ? "What passed"
                    : view.sentence.kind === "brokeAt"
                      ? "What broke"
                      : "What happened"}
                </h4>
                <AiGeneratedLabel />
              </div>
              {hasSentence ? (
                <p
                  className="mt-2 max-w-[72ch] text-sm leading-relaxed text-foreground"
                  data-testid="run-verdict-sentence"
                >
                  {view.sentence.text}
                </p>
              ) : null}
            </div>
            <div className="min-w-0 py-3 lg:px-4 lg:py-2">
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                  {remedy ? (
                    <Wrench
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                  ) : (
                    <Lightbulb
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                  )}
                  {remedy ? "How to fix" : "Next step"}
                </h4>
                <AiGeneratedLabel />
              </div>
              <p
                className="mt-2 text-sm leading-relaxed text-foreground"
                data-testid="run-verdict-remedy"
              >
                {remedy?.text ??
                  (view.pending
                    ? "Results are still arriving. Inspect the live case matrix below as iterations complete."
                    : view.sentence.kind === "noFailure"
                      ? "Compare with a previous run to check for regressions, or export this report to share the evidence."
                      : "Open the case evidence to inspect the recorded result. No specific remediation has been established for this run.")}
              </p>
            </div>
          </div>
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

      <div
        className="grid grid-cols-3 divide-x divide-border/40 border-t border-border/60 pt-3"
        data-testid="run-verdict-stats"
      >
        <Stat
          label="Latency p50"
          value={formatRunCaseLatencyMs(view.stats.latencyP50Ms)}
          detail={`p95 ${formatRunCaseLatencyMs(view.stats.latencyP95Ms)}`}
          delta={view.deltas?.latency}
        />
        <Stat
          label="Tokens"
          value={formatCount(view.stats.tokens)}
          delta={view.deltas?.tokens}
        />
        <Stat
          label="Tool calls"
          value={formatCount(view.stats.toolCalls)}
          delta={view.deltas?.toolCalls}
        />
      </div>
    </section>
  );
}
