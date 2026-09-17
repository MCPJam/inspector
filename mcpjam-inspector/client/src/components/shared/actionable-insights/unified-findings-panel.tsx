/** Product findings view: a lead problem/fix, and evidence drawers. */
import { useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  sortFindingsForDisplay,
  type ActionableFinding,
  type InsightsFindingProvenance,
  type InsightsObservationCoverage,
  type InsightsObservationState,
  type UnifiedFindings,
} from "@/lib/insights-envelope-api";
import type { FindingPromptContext } from "./finding-prompts";
import { CopyFindingPrompt } from "./finding-summary";
import {
  FindingsAllSheet,
  FindingsCarousel,
  FindingsPager,
  useFindingsCarousel,
} from "./findings-carousel";
import type { FindingEvidenceLocator } from "./finding-evidence";
import type { AffectedIterationRow } from "./affected-iterations-list";

export type UnifiedFindingsMode = "deterministic" | "ai";
export type FindingsAnalysisAction = {
  available: boolean;
  pending: boolean;
  error: string | null;
  onRun: () => void;
};
export type UnifiedFindingsPanelProps = {
  runPending?: boolean;
  analysis?: UnifiedFindings["analysis"];
  snapshot: UnifiedFindings["snapshot"];
  findings: readonly ActionableFinding[];
  provenance: readonly InsightsFindingProvenance[];
  observationState: InsightsObservationState | null;
  observationCoverage: InsightsObservationCoverage | null;
  mode: UnifiedFindingsMode;
  analyze: FindingsAnalysisAction;
  analysisFailure?: { errorCode?: string } | null;
  /**
   * The FREE deterministic build.
   *
   * Separate from `analyze` because it spends nothing: it reads recorded
   * evidence and groups it. A run that settled without one (an older run, or
   * one the stale-worker sweeper finalized) must not be told to "Analyze" —
   * that word means the metered model, and the observations do not need it.
   */
  build?: FindingsAnalysisAction;
  backendUnavailableNote?: string | null;
  scopeControl?: React.ReactNode;
  context?: FindingPromptContext;
  onOpenEvidence?: (locator: FindingEvidenceLocator) => void;
  /** Recorded iterations by id, for each finding's affected list. */
  iterationRows?: Record<string, AffectedIterationRow>;
  /**
   * What to show instead of a "nothing here yet" note.
   *
   * The block now occupies the hero's explanation slot, so a run with no
   * built findings must still say what broke. The run page passes the hero's
   * own contract-derived columns; a surface with nothing to fall back to
   * passes nothing and keeps the note.
   */
  fallback?: React.ReactNode;
};

function StateNote({
  tone = "muted",
  children,
  testId,
}: {
  tone?: "muted" | "warning" | "destructive";
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <p
      className={`border-l-2 py-1 pl-3 text-sm leading-relaxed ${
        tone === "destructive"
          ? "border-destructive"
          : tone === "warning"
            ? "border-warning"
            : "border-border"
      }`}
      role={tone === "destructive" ? "alert" : undefined}
      data-testid={testId}
    >
      {children}
    </p>
  );
}

const EXCLUSION_WORDS: Record<string, string> = {
  notTerminal: "still running",
  cancelled: "cancelled",
  chainMissing: "with no recorded contract chain",
  chainUnverified: "without a verified stage chain",
  chainVersionAhead: "stamped by a newer analyzer than this backend reads",
  evaluatorErrored: "where the evaluator itself errored",
  judgePending: "still awaiting a grade",
  judgeSkipped: "the evaluator skipped",
};

function humanExclusion(reason: string): string {
  return EXCLUSION_WORDS[reason] ?? reason;
}

const ANALYSIS_FAILURE_DETAIL: Record<string, string> = {
  evidence_changed: "The recorded evidence changed during analysis.",
  superseded: "The analyzer was updated during analysis.",
  iteration_limit: "This run exceeded the analysis size limit.",
  no_verified_reports: "No trace reports could be verified.",
  lease_expired: "The analysis worker stopped responding.",
  spend_cap_exceeded: "The analysis spend limit was reached.",
  spend_budget_reached: "The analysis spend limit was reached.",
};

export function UnifiedFindingsPanel({
  runPending = false,
  analysis,
  snapshot,
  findings,
  provenance,
  observationState,
  observationCoverage,
  mode,
  analyze,
  analysisFailure,
  build,
  backendUnavailableNote,
  scopeControl,
  context,
  onOpenEvidence,
  iterationRows,
  fallback,
}: UnifiedFindingsPanelProps) {
  const [allOpen, setAllOpen] = useState(false);
  const seeAllTrigger = useRef<HTMLButtonElement>(null);
  // Ordering is a MEASURED fact (actionability, severity, affected count).
  // Whether a model happened to narrate a finding is not, and must not move
  // a bigger problem below a smaller one.
  const sorted = useMemo(() => sortFindingsForDisplay(findings), [findings]);
  const provenanceById = useMemo(
    () => new Map(provenance.map((p) => [p.candidateId, p])),
    [provenance],
  );
  // Every finding the envelope carries, so a consolidated finding can name
  // the measured groups it came from even when this view shows only it.
  const findingsById = useMemo(
    () =>
      new Map(
        [...(snapshot?.deterministicFindings ?? []), ...findings].map((f) => [
          f.id,
          f,
        ]),
      ),
    [snapshot?.deterministicFindings, findings],
  );
  const carousel = useFindingsCarousel();
  const current = sorted[carousel.selected] ?? sorted[0];
  const enrichment = snapshot?.enrichment;
  const discovery =
    mode === "ai" && enrichment?.status === "ready"
      ? enrichment.discovery
      : null;
  const incomplete = discovery
    ? discovery.missingTraces > 0 ||
      discovery.truncatedTraces > 0 ||
      discovery.omittedEvidence > 0 ||
      discovery.reviewedFailedIterations < discovery.totalFailedIterations
    : observationState === "partial" || observationState === "unavailable";

  return (
    <div
      data-testid="unified-findings-panel"
      data-analysis-phase={analysis?.phase}
    >
      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-semibold">Findings</h3>
          {scopeControl}
        </div>
        <div className="flex items-center gap-2">
          <FindingsPager
            selected={carousel.selected}
            count={sorted.length}
            canPrev={carousel.canPrev}
            canNext={carousel.canNext}
            onPrev={carousel.scrollPrev}
            onNext={carousel.scrollNext}
            onSeeAll={() => setAllOpen(true)}
            seeAllRef={seeAllTrigger}
          />
          {analyze.pending ? (
            <span
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {analysis?.phase === "reading"
                ? `Reading iterations ${analysis.progress.done}/${analysis.progress.total}`
                : analysis?.phase === "grouping"
                  ? "Grouping problems…"
                  : analysis?.phase === "checking"
                    ? "Checking evidence…"
                    : "Analyzing…"}
            </span>
          ) : null}
          {current ? (
            <CopyFindingPrompt
              key={current.id}
              finding={current}
              context={context}
            />
          ) : null}
        </div>
      </div>
      {analysis && (
        <p className="mb-4 text-xs text-muted-foreground" role="status">
          Trace reports available for {analysis.completeness.iterationReports}{" "}
          of {analysis.completeness.total} iterations.
          {analysis.phase === "done" &&
          analysis.completeness.iterationReports < analysis.completeness.total
            ? " Some iterations could not be analyzed; recorded results remain available."
            : ""}
        </p>
      )}
      {analysisFailure ? (
        <p
          className="mb-4 text-xs text-muted-foreground"
          data-testid="unified-findings-analysis-failed"
          title={analysisFailure.errorCode}
        >
          AI analysis did not complete.
          {analysisFailure.errorCode &&
          ANALYSIS_FAILURE_DETAIL[analysisFailure.errorCode]
            ? ` ${ANALYSIS_FAILURE_DETAIL[analysisFailure.errorCode]}`
            : null}
        </p>
      ) : null}

      {backendUnavailableNote || analyze.error ? (
        <div className="mb-5 space-y-3">
          {backendUnavailableNote ? (
            <StateNote tone="warning" testId="unified-findings-backend-missing">
              {backendUnavailableNote}
            </StateNote>
          ) : null}
          {analyze.error ? (
            <StateNote
              tone="destructive"
              testId="unified-findings-analysis-error"
            >
              Analysis could not finish: {analyze.error}
              {current ? " Existing findings are still available below." : ""}
            </StateNote>
          ) : null}
        </div>
      ) : null}
      {enrichment?.status === "stale" ? (
        <div className="mb-5">
          <StateNote tone="warning" testId="unified-findings-stale-enrichment">
            The evidence changed after this analysis ran.
          </StateNote>
        </div>
      ) : null}
      {!current &&
      !backendUnavailableNote &&
      !analyze.error &&
      !build?.error &&
      (runPending || analyze.pending || build?.pending) ? (
        <div
          className="grid divide-y divide-border/40 lg:grid-cols-2 lg:divide-x lg:divide-y-0"
          role="status"
          aria-label="Loading findings"
          data-testid="unified-findings-loading"
        >
          {[0, 1].map((column) => (
            <div
              key={column}
              className="min-w-0 space-y-4 py-4 lg:px-6 lg:first:pl-0 lg:last:pr-0"
              aria-hidden="true"
            >
              <Skeleton className="h-3 w-24 rounded-lg" />
              <Skeleton className="h-4 w-full rounded-lg" />
              <Skeleton className="h-4 w-4/5 rounded-lg" />
            </div>
          ))}
        </div>
      ) : !snapshot ? (
        fallback !== undefined && !analyze.pending && !build?.pending ? (
          fallback
        ) : (
          <div className="space-y-2">
            {analyze.pending || build?.pending || build?.available ? (
              <StateNote testId="unified-findings-no-snapshot">
                {analyze.pending || build?.pending
                  ? "Reading this run’s recorded evidence…"
                  : "Findings have not been built for this run yet. Building reads the recorded evidence; it does not call a model."}
              </StateNote>
            ) : null}
            {build?.available && !build.pending && !analyze.pending ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={build.onRun}
                data-testid="unified-findings-build"
              >
                Build findings
              </Button>
            ) : null}
            {build?.error ? (
              <StateNote
                tone="destructive"
                testId="unified-findings-build-error"
              >
                Findings could not be built: {build.error}
              </StateNote>
            ) : null}
          </div>
        )
      ) : sorted.length > 0 ? (
        <div data-testid="unified-findings-list">
          <FindingsCarousel
            findings={sorted}
            provenanceById={provenanceById}
            view={mode}
            context={context}
            onOpenEvidence={onOpenEvidence}
            iterationRows={iterationRows}
            findingsById={findingsById}
            setApi={carousel.setApi}
          />
        </div>
      ) : fallback !== undefined &&
        !(observationState === "unavailable" && !discovery) ? (
        fallback
      ) : (
        <StateNote
          tone={
            observationState === "unavailable" && !discovery
              ? "warning"
              : "muted"
          }
          testId={
            observationState === "unavailable" && !discovery
              ? "unified-findings-unavailable"
              : "unified-findings-empty"
          }
        >
          {observationState === "unavailable" && !discovery
            ? "There isn’t enough recorded evidence to explain this run."
            : incomplete
              ? "No supported finding yet. Evidence is incomplete; this does not mean the run passed."
              : mode === "ai"
                ? "Analysis found no supported issue to report. This does not change the run’s results."
                : "No issue found in the recorded checks."}
        </StateNote>
      )}
      {observationCoverage &&
      Object.values(observationCoverage.exclusions ?? {}).some(
        (count) => count > 0,
      ) ? (
        <p
          className="mt-3 text-xs text-muted-foreground"
          data-testid="unified-findings-exclusion-summary"
        >
          Not analyzed:{" "}
          {Object.entries(observationCoverage.exclusions ?? {})
            .filter(([, count]) => count > 0)
            .map(
              ([reason, count]) =>
                `${count} ${
                  count === 1 ? "iteration" : "iterations"
                } ${humanExclusion(reason)}`,
            )
            .join("; ")}
          .
        </p>
      ) : null}
      <FindingsAllSheet
        open={allOpen}
        onOpenChange={setAllOpen}
        findings={sorted}
        provenanceById={provenanceById}
        view={mode}
        onOpenEvidence={onOpenEvidence}
        iterationRows={iterationRows}
        findingsById={findingsById}
        trigger={seeAllTrigger}
      />
    </div>
  );
}
