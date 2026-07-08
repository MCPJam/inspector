import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import posthog from "posthog-js";
import { cn } from "@/lib/utils";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import type { EvalSuiteRun } from "./types";
import { pickLatestCompletedRun } from "./helpers";
import { useRunInsights } from "./use-run-insights";
import { useRunGroupQuality } from "./use-run-group-quality";
import { GroupFindingList } from "./run-group-diagnosis-presentation";
import {
  insightHighlightCompactLabelClass,
  insightHighlightCompactSectionClass,
  insightHighlightNarrativeClass,
} from "./insight-highlight-chrome";

/** A selected run group — when present, the banner shows cross-host diagnosis. */
export interface InsightGroupScope {
  suiteId: string;
  runGroupId: string;
  runs: EvalSuiteRun[];
}

export interface SuiteInsightsCollapsibleProps {
  runs: EvalSuiteRun[];
  /** Header label, e.g. "Run insights" vs "Commit insights" */
  title?: string;
  /**
   * When a run group is selected in the results split, the banner becomes
   * scope-adaptive and shows the cross-host diagnosis for that group instead
   * of the latest single-run summary. Absent/null ⇒ run-insights behavior.
   */
  groupScope?: InsightGroupScope | null;
  /**
   * The single run currently open in the detail pane, if any. The banner shows
   * THIS run's insights instead of the latest completed run, so the headline
   * always matches the run you're looking at. Null/absent ⇒ latest completed.
   */
  selectedRunId?: string | null;
}

const RUN_INSIGHTS_FAILED_FALLBACK =
  "Could not load this summary. Hit Retry in the header.";

/** Roughly two lines at the suite dashboard width — expand only when longer. */
const SUMMARY_CLAMP_CHARS = 180;

function describeRunInsightsError(code: string | undefined): string {
  switch (code) {
    case "model_timeout":
      return "The judge model timed out. Hit Retry to try again.";
    case "bad_api_key":
      return "Judge model rejected the API key. Check the judge model settings in your workspace.";
    case "model_unavailable":
      return "Judge model is unavailable. Try again in a moment.";
    case "lease_expired":
      return "Insight generation didn't complete in time. Hit Retry to try again.";
    default:
      return RUN_INSIGHTS_FAILED_FALLBACK;
  }
}

function summaryNeedsExpand(text: string): boolean {
  return text.replace(/\s+/g, " ").trim().length > SUMMARY_CLAMP_CHARS;
}

/** Shared banner chrome: sparkle + label on the left, body on the right. */
function InsightBannerShell({
  label,
  children,
  trailing,
}: {
  label: string;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <section className={insightHighlightCompactSectionClass}>
      <div className="flex items-start gap-2.5">
        <div className="flex shrink-0 items-center pt-0.5">
          <span className={insightHighlightCompactLabelClass}>{label}</span>
        </div>
        {children}
        {trailing}
      </div>
    </section>
  );
}

/**
 * Diff-based insights for the latest completed suite run (vs prior baseline),
 * generated lazily on first view.
 */
function RunInsightsBanner({
  runs,
  title,
  selectedRunId,
}: {
  runs: EvalSuiteRun[];
  title: string;
  selectedRunId?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  // Show the open run's insights when one is selected, so the headline matches
  // the run you're viewing; fall back to the latest completed run otherwise.
  const targetRun = useMemo(() => {
    if (selectedRunId) {
      return runs.find((r) => r._id === selectedRunId) ?? null;
    }
    return pickLatestCompletedRun(runs);
  }, [runs, selectedRunId]);

  const {
    summary,
    pending,
    failedGeneration,
    requestRunInsights,
    unavailable,
    requested,
    errorMessage,
  } = useRunInsights(targetRun, { autoRequest: true });

  useEffect(() => {
    if (!targetRun || unavailable) {
      return;
    }
    posthog.capture("eval_run_insights_opened", {
      location: "suite_insights_collapsible",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      title,
      run_id: targetRun._id,
    });
  }, [targetRun, title, unavailable]);

  if (!targetRun || unavailable) {
    return null;
  }

  const persistedErrorCode = (
    targetRun as unknown as { runInsightsErrorCode?: string }
  ).runInsightsErrorCode;
  const failedMessage = failedGeneration
    ? describeRunInsightsError(persistedErrorCode)
    : null;

  const narrative =
    errorMessage ??
    failedMessage ??
    "Open a completed run to see a short summary vs the previous one.";

  const canExpand = summary != null && summaryNeedsExpand(summary);
  const showExpandControl = canExpand && !expanded;

  let body: ReactNode;
  if (summary) {
    body = (
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            insightHighlightNarrativeClass,
            showExpandControl && "line-clamp-2",
          )}
        >
          {summary}
        </p>
        {canExpand ? (
          <button
            type="button"
            className="mt-0.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>
    );
  } else if (pending) {
    body = (
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
        Generating insights vs your previous run…
      </span>
    );
  } else if (requested) {
    body = (
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
        Requesting insights…
      </span>
    );
  } else if (narrative) {
    body = (
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">{narrative}</p>
    );
  } else {
    body = (
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        Compared to your previous completed run.
      </p>
    );
  }

  return (
    <InsightBannerShell
      label={title}
      trailing={
        failedGeneration ? (
          <button
            type="button"
            className="shrink-0 text-xs font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => requestRunInsights(true)}
          >
            Retry
          </button>
        ) : undefined
      }
    >
      {body}
    </InsightBannerShell>
  );
}

/**
 * Cross-host diagnosis for the selected run group, rendered in the same banner
 * surface as run insights. The headline summary sits inline; the structured
 * findings live under "Show more" so the banner stays thin until you dig in.
 */
function CrossHostInsightsBanner({ scope }: { scope: InsightGroupScope }) {
  const [expanded, setExpanded] = useState(false);
  const {
    result,
    pending,
    failedGeneration,
    error,
    requested,
    unavailable,
    allRunsTerminal,
    request,
  } = useRunGroupQuality({
    suiteId: scope.suiteId,
    runGroupId: scope.runGroupId,
    runs: scope.runs,
  });

  // Collapse the detail when switching groups or when a fresh result lands.
  useEffect(() => {
    setExpanded(false);
  }, [scope.runGroupId, result?.generatedAt]);

  // Backend feature not deployed — stay invisible, exactly like run insights.
  if (unavailable) return null;

  const summary = result?.summary ?? null;
  const findings = result?.findings ?? [];
  const canExpand =
    findings.length > 0 || (summary != null && summaryNeedsExpand(summary));
  const showExpandControl = canExpand && !expanded;

  let body: ReactNode;
  if (summary) {
    body = (
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            insightHighlightNarrativeClass,
            showExpandControl && "line-clamp-2",
          )}
        >
          {summary}
        </p>
        {canExpand ? (
          <button
            type="button"
            className="mt-0.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded
              ? "Show less"
              : findings.length > 0
                ? `Show ${findings.length} cross-host finding${findings.length === 1 ? "" : "s"}`
                : "Show more"}
          </button>
        ) : null}
        {expanded && result && findings.length > 0 ? (
          <div className="mt-2 border-t border-border/50 pt-1">
            <GroupFindingList result={result} />
          </div>
        ) : null}
      </div>
    );
  } else if (!allRunsTerminal) {
    body = (
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        Cross-host diagnosis runs once every host in this group has finished.
      </p>
    );
  } else if (pending || requested) {
    body = (
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
        Comparing hosts…
      </span>
    );
  } else if (error) {
    body = (
      <p className="min-w-0 flex-1 text-sm text-destructive">{error}</p>
    );
  } else {
    body = (
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        We'll compare how each host performed on this suite here.
      </p>
    );
  }

  return (
    <InsightBannerShell
      label="Cross-host insights"
      trailing={
        error || failedGeneration ? (
          <button
            type="button"
            className="shrink-0 text-xs font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => request(true)}
          >
            Retry
          </button>
        ) : undefined
      }
    >
      {body}
    </InsightBannerShell>
  );
}

/**
 * Scope-adaptive insight banner. Shows the cross-host diagnosis when a run
 * group is selected, otherwise the latest-run insights summary. Split into two
 * child components so each owns its own hooks (the surfaces use different data
 * sources and must not share a hook-call order).
 */
export function SuiteInsightsCollapsible({
  runs,
  title = "Run insights",
  groupScope,
  selectedRunId,
}: SuiteInsightsCollapsibleProps) {
  if (groupScope) {
    return <CrossHostInsightsBanner scope={groupScope} />;
  }
  return (
    <RunInsightsBanner
      runs={runs}
      title={title}
      selectedRunId={selectedRunId}
    />
  );
}
