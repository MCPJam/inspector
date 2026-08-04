import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";

import { cn } from "@/lib/utils";
import { useCreditEstimateEnabled } from "@/hooks/useCreditEstimateEnabled";
import {
  formatCredits,
  formatRunCostEstimate,
  useJourneyRunCostEstimate,
  useQuickCaseRunCostEstimate,
  useSuiteRunCostEstimate,
  type QuickCaseEstimateModel,
  type RunCostEstimateState,
} from "@/hooks/use-run-cost-estimate";

/**
 * Info icon whose tooltip shows what the run about to be launched is estimated
 * to cost. Purely presentational — the caller owns the flag gate and passes the
 * fetch state, and the estimate is fetched only while the tooltip is open (see
 * `use-run-cost-estimate`).
 *
 * Styled after `InfoHint` (`global-gates-info.tsx`) so it reads as the same kind
 * of affordance as the other inline hints.
 *
 * The number is never a promise: copy always says "Estimated" / "At least"
 * / "Rough estimate", and this control NEVER gates or disables the run.
 */
export function RunCostEstimateHint({
  state,
  label = "Estimated credit cost",
  className,
  side = "bottom",
  align = "center",
}: {
  state: RunCostEstimateState;
  label?: string;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}) {
  const summary = formatRunCostEstimate(state);
  const detailLines =
    state.status === "ready" && state.estimate
      ? state.estimate.lines.filter((line) => line.units > 0)
      : [];

  return (
    <Tooltip open={state.open} onOpenChange={state.setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid="run-cost-estimate-hint"
          onClick={(e) => {
            // Stop the click reaching a surrounding row/card handler that would
            // navigate away or start the run. Deliberately NOT
            // `preventDefault()` — that suppresses Radix's activation-close, so
            // a keyboard or touch activation would open the tooltip and be
            // unable to close it. `type="button"` already blocks form submits.
            e.stopPropagation();
          }}
          className={cn(
            "rounded-full p-0.5 text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <Info className="size-3" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent
        variant="muted"
        side={side}
        align={align}
        className="max-w-[20rem] px-2.5 py-2"
      >
        <div className="space-y-1 text-xs leading-snug">
          <p className="font-medium">{summary}</p>
          {detailLines.length > 0 ? (
            <ul className="space-y-0.5 text-muted-foreground">
              {/* Labels are display strings and CAN repeat (two environments
                  can share a name, and every unresolved target renders the same
                  placeholder), so the index is part of the key. */}
              {detailLines.map((line, index) => (
                <li
                  key={`${index}:${line.label}`}
                  className="flex justify-between gap-3"
                >
                  <span className="truncate">
                    {line.label} × {formatCredits(line.units)}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {line.credits === null
                      ? "unpriced"
                      : `~${formatCredits(line.credits)}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {state.status === "ready" && state.estimate?.truncated ? (
            <p className="text-muted-foreground">
              Some history was capped, so this is a partial picture.
            </p>
          ) : null}
          <p className="text-muted-foreground">
            1 credit = $0.01. Your free daily allowance and any BYOK keys change
            what is actually deducted.
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

type HintChromeProps = {
  label?: string;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
};

type QuickCaseEstimateArgs = {
  suiteId: string | null | undefined;
  caseId?: string | null;
  models: readonly QuickCaseEstimateModel[];
  runs?: number;
  draft?: { promptChars: number; stepCount: number };
};

/**
 * Quick-run / draft-run variant: owns the flag gate and the fetch so it can be
 * dropped beside a per-case Run control inside a list (where a hook can't be
 * called from the row callback).
 *
 * `suppressed` is how a caller says "this control will NOT actually run" — an
 * environment suite (quick-run toasts and returns), a case with no models ("Add
 * a model first"), or a model-free render check. An estimate beside a control
 * that never spends is worse than no estimate, so nothing renders and no query
 * fires in those cases.
 *
 * The FETCH hook lives in a child component that is only mounted once the gate
 * passes. That is deliberate: with the flag off this component touches no Convex
 * client at all, which is what "flag off ⇒ no render, no query" has to mean for
 * a surface that renders one of these per row.
 */
export function QuickCaseRunCostEstimateHint({
  suppressed = false,
  label = "Estimated credit cost of this run",
  className,
  side = "left",
  align = "center",
  ...args
}: QuickCaseEstimateArgs & HintChromeProps & { suppressed?: boolean }) {
  const flagEnabled = useCreditEstimateEnabled();
  if (!flagEnabled || suppressed || !args.suiteId) {
    return null;
  }
  return (
    <QuickCaseEstimateFetcher
      {...args}
      label={label}
      className={className}
      side={side}
      align={align}
    />
  );
}

function QuickCaseEstimateFetcher({
  suiteId,
  caseId,
  models,
  runs,
  draft,
  label,
  className,
  side,
  align,
}: QuickCaseEstimateArgs & HintChromeProps) {
  const state = useQuickCaseRunCostEstimate({
    enabled: true,
    suiteId,
    caseId: caseId ?? null,
    models,
    ...(runs !== undefined ? { runs } : {}),
    ...(draft ? { draft } : {}),
  });
  return (
    <RunCostEstimateHint
      state={state}
      label={label}
      className={className}
      side={side}
      align={align}
    />
  );
}

/**
 * Suite "Run all" variant. Same gate-then-mount shape as the quick-case one so a
 * flagged-off suite header never constructs an estimate subscription.
 */
export function SuiteRunCostEstimateHint({
  suiteId,
  caseIds,
  iterationOverride,
  planCount,
  suppressed = false,
  label = "Estimated credit cost of running this suite",
  className,
  side = "bottom",
  align = "center",
}: {
  suiteId: string | null | undefined;
  caseIds?: readonly string[];
  iterationOverride?: number;
  planCount?: number;
  /** Set when Run all cannot launch at all (no cases, no servers configured). */
  suppressed?: boolean;
} & HintChromeProps) {
  const flagEnabled = useCreditEstimateEnabled();
  if (!flagEnabled || suppressed || !suiteId) {
    return null;
  }
  return (
    <SuiteEstimateFetcher
      suiteId={suiteId}
      caseIds={caseIds}
      iterationOverride={iterationOverride}
      planCount={planCount}
      label={label}
      className={className}
      side={side}
      align={align}
    />
  );
}

function SuiteEstimateFetcher({
  suiteId,
  caseIds,
  iterationOverride,
  planCount,
  label,
  className,
  side,
  align,
}: {
  suiteId: string;
  caseIds?: readonly string[];
  iterationOverride?: number;
  planCount?: number;
} & HintChromeProps) {
  const state = useSuiteRunCostEstimate({
    enabled: true,
    suiteId,
    ...(caseIds ? { caseIds } : {}),
    ...(iterationOverride !== undefined ? { iterationOverride } : {}),
    ...(planCount !== undefined ? { planCount } : {}),
  });
  return (
    <RunCostEstimateHint
      state={state}
      label={label}
      className={className}
      side={side}
      align={align}
    />
  );
}

/**
 * Swarm journey-card variant. The gate-then-mount split matters most here: the
 * Journeys list renders one card per journey, so a flagged-off list must not
 * spin up N estimate state machines.
 */
export function JourneyRunCostEstimateHint({
  journeyId,
  configKey,
  label = "Estimated credit cost of the next run",
  className,
  side = "top",
  align = "center",
}: {
  journeyId: string | null | undefined;
  /** See `useJourneyRunCostEstimate` — re-fetches an open tooltip on a config edit. */
  configKey?: string;
} & HintChromeProps) {
  const flagEnabled = useCreditEstimateEnabled();
  if (!flagEnabled || !journeyId) {
    return null;
  }
  return (
    <JourneyEstimateFetcher
      journeyId={journeyId}
      configKey={configKey}
      label={label}
      className={className}
      side={side}
      align={align}
    />
  );
}

function JourneyEstimateFetcher({
  journeyId,
  configKey,
  label,
  className,
  side,
  align,
}: { journeyId: string; configKey?: string } & HintChromeProps) {
  const state = useJourneyRunCostEstimate({
    enabled: true,
    journeyId,
    configKey,
  });
  return (
    <RunCostEstimateHint
      state={state}
      label={label}
      className={className}
      side={side}
      align={align}
    />
  );
}
