import { useMemo } from "react";
import { AlertTriangle, Route } from "lucide-react";
import {
  readExecutionRecord,
  summarizeExecutionRecord,
  type ExecutionProvenanceSummary,
} from "@mcpjam/sdk/browser";

import { cn } from "@/lib/utils";

/**
 * What a result actually ran on: "Ran on <model> via <rail/connection>,
 * <harness vX>, effort/temp, max output", plus a visible DEVIATION banner when
 * the execution record says the run differed from what was requested (a
 * provider fallback, a substituted model or harness).
 *
 * One component for every surface that has a record — eval iterations and
 * their scorecard, swarm sessions, chat turns — so they all say the same
 * thing in the same words (the line itself comes from the SDK, which the CLI
 * prints too).
 *
 * `execution` is the raw value off the row / response / message metadata. It
 * is read through `readExecutionRecord`, known keys only, so nothing beyond
 * the contract renders — and a record names a connection, never a key.
 *
 * ABSENT OR MALFORMED ⇒ nothing, or "not recorded" when the caller asks for
 * it. Never a line reconstructed from the case's model id: rows written before
 * records existed have no answer to this question, and a guess would read as
 * one.
 */
export function ExecutionProvenance({
  execution,
  showNotRecorded = false,
  className,
  testIdPrefix = "execution",
}: {
  execution: unknown;
  /** Render "Model provenance not recorded" instead of nothing. */
  showNotRecorded?: boolean;
  className?: string;
  /** Distinguishes several mounts on one page (e.g. per chat turn). */
  testIdPrefix?: string;
}) {
  const summary = useMemo(() => {
    const record = readExecutionRecord(execution);
    return record ? summarizeExecutionRecord(record) : null;
  }, [execution]);

  if (!summary) {
    return showNotRecorded ? (
      <p
        className={cn("text-[11px] text-muted-foreground", className)}
        data-testid={`${testIdPrefix}-provenance-not-recorded`}
      >
        Model provenance not recorded
      </p>
    ) : null;
  }
  return (
    <ExecutionProvenanceView
      summary={summary}
      className={className}
      testIdPrefix={testIdPrefix}
    />
  );
}

function ExecutionProvenanceView({
  summary,
  className,
  testIdPrefix,
}: {
  summary: ExecutionProvenanceSummary;
  className?: string;
  testIdPrefix: string;
}) {
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1", className)}
      data-testid={`${testIdPrefix}-provenance`}
    >
      {summary.deviation ? (
        // Visible, not tucked into the details: a result that ran somewhere
        // other than where it was asked to is the one fact about provenance a
        // reader must not miss.
        <div
          role="status"
          className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400"
          data-testid={`${testIdPrefix}-deviation-banner`}
        >
          <AlertTriangle className="mt-[1px] size-3 shrink-0" aria-hidden />
          <span className="min-w-0">
            <span className="font-semibold">
              Deviation: {summary.deviation.title}
            </span>
            {summary.deviation.reason ? ` — ${summary.deviation.reason}` : null}
          </span>
        </div>
      ) : null}
      <details className="group min-w-0 text-[11px] text-muted-foreground">
        <summary
          className="flex cursor-pointer list-none items-start gap-1.5 [&::-webkit-details-marker]:hidden"
          data-testid={`${testIdPrefix}-provenance-line`}
        >
          <Route className="mt-[1px] size-3 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{summary.line}</span>
        </summary>
        <ul
          className="mt-1 space-y-0.5 pl-[18px]"
          data-testid={`${testIdPrefix}-provenance-details`}
        >
          <li>{summary.request}</li>
          {summary.attempts.map((attempt, index) => (
            <li key={index}>{attempt}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
