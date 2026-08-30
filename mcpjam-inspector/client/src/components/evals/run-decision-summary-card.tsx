/**
 * D9's canonical run decision summary, rendered.
 *
 * ── Why this component exists ────────────────────────────────────────────────
 *
 * Run detail already shows KPIs, an accuracy hero and an insight rail, all
 * computed in the browser from iteration rows. Those answer "how did the
 * trials go". None of them answers "what did this run DECIDE", because until
 * D9 the browser had no way to know: it would have had to aggregate trials
 * into a verdict itself, which is the fourth independent reading of a run that
 * the contract exists to prevent. This card is the run's own answer, fetched
 * whole and rendered without arithmetic.
 *
 * NOTHING in this file computes a verdict, a rate, a count or a completeness
 * claim. Every number is read off the validated contract, every word comes
 * from the SDK's label maps, and the one place a local fact appears (the
 * client's own "we followed every cursor") is named as such beside the
 * server's own `complete`, never merged into it.
 *
 * ── The trace link is an API path, not a route ───────────────────────────────
 *
 * `evidence.tracePath` is the trace ENDPOINT's path relative to the API root.
 * Treating it as an application route would navigate the app to a URL that
 * does not exist there. The card therefore never links it directly: it offers
 * a callback keyed by (runId, iterationId), and only when the identity in the
 * evidence actually matches the run being viewed.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { evalSurfaceCardClass, evalSurfaceHeaderClass } from "./eval-surface-chrome";
import {
  DECISION_VERDICT_TONE_CLASS,
  decisionMeasurementUnitLabel,
  decisionReasonLines,
  decisionUndecidedLine,
  decisionValidityHolds,
  decisionVerdictLabel,
  decisionVerdictSourceLabel,
  describeDiagnosticChain,
  describeDiagnosticEvidence,
  describeDiagnosticsScope,
  diagnosticNextAction,
  formatDecisionCounts,
  truncateUntrusted,
} from "./run-decision-summary-presentation";
import type { EvalRunDecisionSummaryError } from "@/lib/apis/eval-run-decision-summary-api";
import type {
  EvalRunDecisionDiagnostic,
  EvalRunDecisionSummary,
} from "@mcpjam/sdk/contract";

export interface RunDecisionSummaryCardProps {
  status: "disabled" | "loading" | "ready" | "error";
  summary: EvalRunDecisionSummary | null;
  error: EvalRunDecisionSummaryError | null;
  diagnostics: EvalRunDecisionDiagnostic[];
  scannedIterations: number;
  serverComplete: boolean;
  walkExhausted: boolean;
  canLoadMore: boolean;
  isLoadingMore: boolean;
  pageError: EvalRunDecisionSummaryError | null;
  onLoadMore: () => void;
  onRetryFailedPage: () => void;
  /**
   * Focus the evidence this diagnostic names. Called with identities the card
   * verified against the run it is showing — see the header note on
   * `tracePath` — and with the CASE the iteration belongs to, because that is
   * what the viewer can actually open to.
   */
  onViewTrace?: (target: {
    runId: string;
    iterationId: string;
    testCaseId: string;
  }) => void;
}

/** Human copy for each way the read can come back without a summary. */
const FAILURE_COPY: Record<
  EvalRunDecisionSummaryError["kind"],
  { title: string; detail: string }
> = {
  notFound: {
    title: "No decision summary for this run",
    detail:
      "This project has no run with that id, or it is no longer visible here.",
  },
  routeUnavailable: {
    title: "Decision summaries are not available on this deployment",
    detail:
      "The API this app is talking to does not serve the run decision summary contract.",
  },
  invalidContract: {
    title: "The decision summary did not match its contract",
    detail:
      "The API answered with a payload this build cannot validate, so nothing from it is shown. This is a bug worth reporting.",
  },
  requestFailed: {
    title: "Couldn't load the decision summary",
    detail: "The read did not complete. It will be retried automatically.",
  },
};

export function RunDecisionSummaryCard({
  status,
  summary,
  error,
  diagnostics,
  scannedIterations,
  serverComplete,
  walkExhausted,
  canLoadMore,
  isLoadingMore,
  pageError,
  onLoadMore,
  onRetryFailedPage,
  onViewTrace,
}: RunDecisionSummaryCardProps) {
  if (status === "disabled") return null;

  return (
    <section
      className={cn(evalSurfaceCardClass, "mb-4 overflow-hidden")}
      aria-labelledby="run-decision-summary-heading"
      data-testid="run-decision-summary"
    >
      <div className={cn(evalSurfaceHeaderClass, "px-5 py-3")}>
        <h3
          id="run-decision-summary-heading"
          className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Run decision
        </h3>
      </div>

      {/*
        Announced, not just repainted: the card swaps between loading, a
        verdict, and an explicit failure, and someone using a screen reader
        must hear that change rather than discover it by re-reading.
      */}
      <div className="px-5 py-4" aria-live="polite" aria-busy={status === "loading"}>
        {status === "loading" ? (
          <p className="text-sm text-muted-foreground">
            Loading the run's decision…
          </p>
        ) : status === "error" || !summary ? (
          <DecisionSummaryFailure error={error} />
        ) : (
          <DecisionSummaryBody
            summary={summary}
            diagnostics={diagnostics}
            scannedIterations={scannedIterations}
            serverComplete={serverComplete}
            walkExhausted={walkExhausted}
            canLoadMore={canLoadMore}
            isLoadingMore={isLoadingMore}
            pageError={pageError}
            onLoadMore={onLoadMore}
            onRetryFailedPage={onRetryFailedPage}
            onViewTrace={onViewTrace}
          />
        )}
      </div>
    </section>
  );
}

function DecisionSummaryFailure({
  error,
}: {
  error: EvalRunDecisionSummaryError | null;
}) {
  const copy = error ? FAILURE_COPY[error.kind] : FAILURE_COPY.requestFailed;
  // The server's own message is untrusted text: rendered as text (React
  // escapes it) and length-bounded, never as markup.
  const detail =
    error?.kind === "notFound" ? truncateUntrusted(error.message) : null;
  return (
    <div data-testid="run-decision-summary-error">
      <p className="text-sm font-medium text-foreground">{copy.title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{copy.detail}</p>
      {detail ? (
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      ) : null}
    </div>
  );
}

function DecisionSummaryBody({
  summary,
  diagnostics,
  scannedIterations,
  serverComplete,
  walkExhausted,
  canLoadMore,
  isLoadingMore,
  pageError,
  onLoadMore,
  onRetryFailedPage,
  onViewTrace,
}: Omit<RunDecisionSummaryCardProps, "status" | "error"> & {
  summary: EvalRunDecisionSummary;
}) {
  const counts = formatDecisionCounts(summary.counts);
  const unit = decisionMeasurementUnitLabel(summary.counts);
  const reasons = decisionReasonLines(summary);
  const undecided = decisionUndecidedLine(summary);
  const validityHolds = decisionValidityHolds(summary);

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={cn(
            "text-lg font-semibold",
            DECISION_VERDICT_TONE_CLASS[summary.verdict],
          )}
          data-testid="run-decision-verdict"
        >
          {decisionVerdictLabel(summary.verdict)}
        </span>
        <span
          className="text-xs text-muted-foreground"
          data-testid="run-decision-verdict-source"
        >
          {/* Which evidence a reader may trust, stated rather than implied. */}
          from {decisionVerdictSourceLabel(summary)}
        </span>
      </div>

      {counts ? (
        <p
          className="mt-1 text-sm tabular-nums text-foreground"
          data-testid="run-decision-counts"
        >
          {counts}
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          {/* Absence stays absence: a run that recorded no counts has not
              recorded a total of zero. */}
          This run reports no counts.
        </p>
      )}
      {unit && counts ? (
        <p className="text-[11px] text-muted-foreground">
          counted in {unit}
          {summary.verdictSource === "legacy"
            ? " — a legacy percent-threshold run, so these are trials, not cases"
            : ""}
        </p>
      ) : null}

      {undecided ? (
        <p
          className="mt-3 text-xs text-muted-foreground"
          data-testid="run-decision-undecided"
        >
          {/* NOT a failure and NOT inconclusive — see the presentation
              module's header. */}
          No verdict was established: {undecided}
          {summary.undecided?.detail
            ? ` (${truncateUntrusted(summary.undecided.detail)})`
            : ""}
        </p>
      ) : null}

      {validityHolds !== null ? (
        <p
          className="mt-3 text-xs text-muted-foreground"
          data-testid="run-decision-validity"
        >
          Validity phase {validityHolds ? "held" : "did not hold"}.
        </p>
      ) : null}

      {reasons.length > 0 ? (
        <ul
          className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground"
          data-testid="run-decision-reasons"
        >
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}

      <p
        className="mt-4 text-[11px] text-muted-foreground"
        data-testid="run-decision-diagnostics-scope"
      >
        {describeDiagnosticsScope({
          shown: diagnostics.length,
          scannedIterations,
          serverComplete,
          walkExhausted,
        })}
      </p>

      {diagnostics.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {diagnostics.map((diagnostic) => (
            <li key={diagnostic.iterationId}>
              <DiagnosticRow
                diagnostic={diagnostic}
                runId={summary.runId}
                onViewTrace={onViewTrace}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {pageError ? (
        <div className="mt-3" data-testid="run-decision-page-error">
          <p className="text-xs text-destructive">
            {FAILURE_COPY[pageError.kind].title}. The pages already loaded are
            unchanged.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-1"
            onClick={onRetryFailedPage}
          >
            Retry that page
          </Button>
        </div>
      ) : null}

      {canLoadMore ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={onLoadMore}
          disabled={isLoadingMore}
          data-testid="run-decision-load-more"
        >
          {isLoadingMore ? "Loading…" : "Load more trials"}
        </Button>
      ) : null}
    </>
  );
}

function DiagnosticRow({
  diagnostic,
  runId,
  onViewTrace,
}: {
  diagnostic: EvalRunDecisionDiagnostic;
  runId: string;
  onViewTrace?: (target: {
    runId: string;
    iterationId: string;
    testCaseId: string;
  }) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const chain = describeDiagnosticChain(diagnostic);
  const evidence = describeDiagnosticEvidence(diagnostic);
  const title = truncateUntrusted(diagnostic.title) ?? "Untitled case";
  const observedFailure = truncateUntrusted(diagnostic.observed?.failure);
  // Three conditions, and the third is the one that keeps this control honest.
  //
  // The evidence names its own run and iteration, so a locator that does not
  // match the run on screen would navigate somewhere this view cannot answer
  // for. And the app focuses an iteration THROUGH its case — that is the only
  // path the viewer actually consumes — so without a case id there is nowhere
  // to send the reader. A button that lands on the page it is already on,
  // having opened nothing, reads as broken; not offering it is the honest
  // answer, and the same rule that keeps this card from claiming span or
  // prompt focus it cannot perform.
  const traceable =
    Boolean(onViewTrace) &&
    diagnostic.evidence.runId === runId &&
    diagnostic.evidence.iterationId === diagnostic.iterationId &&
    Boolean(diagnostic.testCaseId);

  const detailId = `run-decision-diagnostic-${diagnostic.iterationId}`;

  return (
    <div className="rounded-lg border border-border/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls={detailId}
          className="flex items-center gap-1 text-left text-xs font-medium text-foreground hover:underline"
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" aria-hidden />
          ) : (
            <ChevronRight className="h-3 w-3" aria-hidden />
          )}
          {title}
        </button>
        <span className="text-[10px] text-muted-foreground">
          iteration {diagnostic.iterationNumber}
        </span>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        {chain.firstFailedStageLine}
      </p>
      <p className="text-xs text-muted-foreground">{chain.failureCategoryLine}</p>
      {chain.trustNote ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {chain.trustNote}
        </p>
      ) : null}

      <div id={detailId} hidden={!expanded}>
        {chain.stageLines.length > 0 ? (
          <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
            {chain.stageLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {observedFailure ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Observed: {observedFailure}
          </p>
        ) : null}
        {evidence ? (
          <p className="mt-1 text-[11px] text-muted-foreground">{evidence}</p>
        ) : null}
        <p className="mt-1 text-[11px] text-muted-foreground">
          Next action: {diagnosticNextAction(diagnostic)}
        </p>
        {traceable ? (
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() =>
              onViewTrace?.({
                runId: diagnostic.evidence.runId,
                iterationId: diagnostic.evidence.iterationId,
                testCaseId: diagnostic.testCaseId as string,
              })
            }
            data-testid={`run-decision-view-trace-${diagnostic.iterationId}`}
          >
            View trace
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Compact per-kind copy for a table cell, where the card's full sentences
 * do not fit. The `title` carries the fuller explanation.
 */
const VERDICT_UNAVAILABLE_LABELS: Record<
  EvalRunDecisionSummaryError["kind"],
  string
> = {
  notFound: "No summary",
  routeUnavailable: "Not available",
  invalidContract: "Invalid summary",
  requestFailed: "Load failed",
};

/**
 * What a row shows when the canonical read SETTLED without a summary.
 *
 * The alternative — falling back to the row's locally derived label — is the
 * precise bug this whole surface exists to remove. A stale `Passed` presented
 * with no hint that the run's own answer could not be read is worse than
 * saying nothing: it looks authoritative and it is not. So the row says what
 * happened instead, and the four kinds stay four, because only one of them
 * ("Invalid summary") is a bug report.
 *
 * This is NOT the loading state. While the read is in flight a row keeps its
 * lifecycle label, which is the only answer it has yet.
 */
export function RunDecisionVerdictUnavailable({
  error,
  className,
}: {
  error: EvalRunDecisionSummaryError | null;
  className?: string;
}) {
  const kind = error?.kind ?? "requestFailed";
  return (
    <span
      className={cn(
        "text-xs font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
      data-testid="run-decision-verdict-unavailable"
      title={FAILURE_COPY[kind].title}
    >
      {VERDICT_UNAVAILABLE_LABELS[kind]}
    </span>
  );
}

/**
 * The verdict badge for a table row.
 *
 * Renders NOTHING until a canonical summary is in hand — a row whose summary
 * has not arrived keeps whatever lifecycle text it already had, and a row
 * whose summary failed to load says so rather than falling back to locally
 * derived arithmetic. That fallback is the whole bug this replaces.
 */
export function RunDecisionVerdictBadge({
  summary,
  className,
}: {
  summary: EvalRunDecisionSummary;
  className?: string;
}) {
  const counts = formatDecisionCounts(summary.counts);
  return (
    <span
      className={cn(
        "text-xs font-medium uppercase tracking-wide",
        DECISION_VERDICT_TONE_CLASS[summary.verdict],
        className,
      )}
      data-testid="run-decision-verdict-badge"
      title={counts ?? undefined}
    >
      {decisionVerdictLabel(summary.verdict)}
    </span>
  );
}
