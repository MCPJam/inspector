import { useMemo, useState } from "react";
import { Loader2, ChevronDown } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import type { EvalSuiteRun } from "./types";
import { pickLatestCompletedRun } from "./helpers";
import { useRunInsights } from "./use-run-insights";
import {
  insightHighlightAccentClass,
  insightHighlightBodyClass,
  insightHighlightHeaderRowClass,
  insightHighlightNarrativeClass,
  insightHighlightSectionClass,
  insightHighlightSubtitleClass,
  insightHighlightTitleClass,
  insightHighlightTriggerClass,
} from "./insight-highlight-chrome";

export interface SuiteInsightsCollapsibleProps {
  runs: EvalSuiteRun[];
  /** Header label, e.g. "Run insights" vs "Commit insights" */
  title?: string;
}

function runInsightsHeaderSubtitle({
  pending,
  failedGeneration,
  summary,
  requested,
}: {
  pending: boolean;
  failedGeneration: boolean;
  summary: string | null;
  requested: boolean;
}): string {
  if (pending) return "Generating…";
  if (failedGeneration) return "Summary unavailable";
  if (summary) return "Compared to your previous completed run";
  if (requested) return "Requesting…";
  return "Compared to your previous completed run";
}

const RUN_INSIGHTS_FAILED_FALLBACK =
  "Could not load this summary. Hit Retry in the header.";

/**
 * Map the persisted `runInsightsErrorCode` (set by the judge worker on PR B)
 * to user-friendly copy. Unknown / missing codes fall back to the existing
 * generic message so the surface stays stable across server versions.
 */
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

/**
 * Diff-based insights for the latest completed suite run (vs prior baseline),
 * generated lazily on first view.
 */
export function SuiteInsightsCollapsible({
  runs,
  title = "Run insights",
}: SuiteInsightsCollapsibleProps) {
  const [open, setOpen] = useState(true);
  const shouldReduceMotion = useReducedMotion();
  const latestCompleted = useMemo(() => pickLatestCompletedRun(runs), [runs]);

  const {
    summary,
    pending,
    failedGeneration,
    requestRunInsights,
    unavailable,
    requested,
    errorMessage,
  } = useRunInsights(latestCompleted, { autoRequest: true });

  if (!latestCompleted || unavailable) {
    return null;
  }

  const headerSubtitle = runInsightsHeaderSubtitle({
    pending,
    failedGeneration,
    summary,
    requested,
  });

  // Persisted error fields land on `testSuiteRun` via PR B (judge worker).
  // Generated Convex types may not include them on this branch yet — read
  // defensively. When PR B merges these become first-class on EvalSuiteRun.
  const persistedErrorCode = (
    latestCompleted as unknown as { runInsightsErrorCode?: string }
  ).runInsightsErrorCode;
  const failedMessage = failedGeneration
    ? describeRunInsightsError(persistedErrorCode)
    : null;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={insightHighlightSectionClass}
    >
      <div className={insightHighlightAccentClass} aria-hidden />
      <div className={insightHighlightHeaderRowClass}>
        <CollapsibleTrigger asChild>
          <motion.button
            type="button"
            className={insightHighlightTriggerClass}
            whileTap={
              shouldReduceMotion
                ? undefined
                : { scale: 0.992, transition: { duration: 0.08 } }
            }
            transition={{ type: "spring", stiffness: 520, damping: 32 }}
          >
            <motion.span
              className="inline-flex shrink-0 text-primary/70"
              aria-hidden
              initial={false}
              animate={{ rotate: open ? 0 : -90 }}
              transition={
                shouldReduceMotion
                  ? { duration: 0 }
                  : { type: "spring", stiffness: 420, damping: 28 }
              }
            >
              <ChevronDown className="h-4 w-4" />
            </motion.span>
            <div className="min-w-0 flex-1">
              <span className={insightHighlightTitleClass}>{title}</span>
              <p className={insightHighlightSubtitleClass}>{headerSubtitle}</p>
            </div>
          </motion.button>
        </CollapsibleTrigger>
        {failedGeneration ? (
          <div className="flex shrink-0 items-center pr-3">
            <button
              type="button"
              className="text-xs font-medium text-primary underline-offset-2 hover:underline"
              onClick={() => requestRunInsights(true)}
            >
              Retry
            </button>
          </div>
        ) : null}
      </div>
      <CollapsibleContent>
        <div className={insightHighlightBodyClass}>
          {pending ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              Generating insights…
            </span>
          ) : summary ? (
            <p className={insightHighlightNarrativeClass}>{summary}</p>
          ) : requested ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              Requesting insights…
            </span>
          ) : errorMessage ? (
            // Fresh request-time rejections (e.g. spend-cap on a Retry
            // click) must win over the stale persisted "failed" state —
            // otherwise the user clicks Retry, the server rejects, and
            // they keep seeing the same old "Could not load this summary"
            // copy because `runInsightsStatus` hasn't changed yet.
            <p className="text-sm text-muted-foreground">{errorMessage}</p>
          ) : failedGeneration ? (
            <p className="text-sm text-muted-foreground">{failedMessage}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Open a completed run to see a short summary vs the previous one.
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
