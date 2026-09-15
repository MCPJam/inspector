/** Product findings view: one analysis action, a lead problem/fix, and evidence drawers. */
import { useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, ChevronRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@mcpjam/design-system/sheet";
import {
  sortFindingsForDisplay,
  type ActionableFinding,
  type InsightsFindingProvenance,
  type InsightsObservationCoverage,
  type InsightsObservationState,
  type UnifiedFindingsExperiment,
} from "@/lib/insights-envelope-api";
import type { FindingPromptContext } from "./finding-prompts";
import { FindingSummary, CopyFindingPrompt } from "./finding-summary";
import type { FindingEvidenceLocator } from "./finding-evidence";
import type { AffectedIterationRow } from "./affected-iterations-list";

export type UnifiedFindingsMode = "deterministic" | "ai" | "baseline";
export type FindingsAnalysisAction = {
  available: boolean;
  pending: boolean;
  error: string | null;
  onRun: () => void;
};
export type UnifiedFindingsPanelProps = {
  analysis?: UnifiedFindingsExperiment["analysis"];
  snapshot: UnifiedFindingsExperiment["snapshot"];
  findings: readonly ActionableFinding[];
  provenance: readonly InsightsFindingProvenance[];
  observationState: InsightsObservationState | null;
  observationCoverage: InsightsObservationCoverage | null;
  mode: UnifiedFindingsMode;
  analyze: FindingsAnalysisAction;
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
  executionIssues?: React.ReactNode;
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

function CoverageLine({
  state,
  coverage,
  omittedGroups,
  trim,
}: {
  state: InsightsObservationState | null;
  coverage: InsightsObservationCoverage | null;
  omittedGroups: number;
  trim: { droppedEvidence: number; droppedCandidates: number } | null;
}) {
  if (!coverage) return null;
  // Same reason as `judgeCoverageLine`: the envelope is cast, not validated,
  // so a version skew must cost the exclusions line, not the whole panel.
  const exclusions = Object.entries(coverage.exclusions ?? {}).filter(
    ([, count]) => count > 0,
  );
  return (
    <div
      className="space-y-1 text-[12px] text-muted-foreground"
      data-testid="unified-findings-coverage"
      data-observation-state={state ?? "unknown"}
    >
      <p>
        Analyzed {coverage.analyzed} of {coverage.total} iterations
        {coverage.gradedCount > 0 ? `, ${coverage.gradedCount} graded` : ""}.
        {state === "partial"
          ? " This does not describe the whole run — see the exclusions below."
          : ""}
      </p>
      {exclusions.length > 0 ? (
        <p data-testid="unified-findings-exclusions">
          Left out:{" "}
          {exclusions
            .map(([reason, count]) => `${count} ${humanExclusion(reason)}`)
            .join(", ")}
          .
        </p>
      ) : null}
      {omittedGroups > 0 ? (
        <p data-testid="unified-findings-omitted">
          {omittedGroups} further group{omittedGroups === 1 ? "" : "s"} ranked
          below the display cap and {omittedGroups === 1 ? "is" : "are"} not
          shown.
        </p>
      ) : null}
      {trim && (trim.droppedCandidates > 0 || trim.droppedEvidence > 0) ? (
        <p data-testid="unified-findings-trim">
          Trimmed for size: {trim.droppedCandidates} finding
          {trim.droppedCandidates === 1 ? "" : "s"}, {trim.droppedEvidence}{" "}
          evidence record{trim.droppedEvidence === 1 ? "" : "s"}.
        </p>
      ) : null}
    </div>
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

function BaselineView({
  baseline,
}: {
  baseline: NonNullable<
    NonNullable<UnifiedFindingsExperiment["snapshot"]>["baseline"]
  >;
}) {
  return (
    <div className="space-y-2" data-testid="unified-findings-baseline">
      <StateNote tone="muted">
        This is the analysis that existed <em>before</em> these observations
        were built, preserved so the two can be compared. It was generated{" "}
        {new Date(baseline.generatedAt).toLocaleString()} by{" "}
        <code className="font-code">{baseline.modelUsed}</code>
        {baseline.inputIdentity === "unknown"
          ? " against inputs this run did not record, so do not read it as having seen today's configuration."
          : "."}
      </StateNote>
      <p className="text-[13px] leading-relaxed text-foreground">
        {baseline.summary}
      </p>
      {baseline.lines.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4 text-[12.5px] text-muted-foreground">
          {baseline.lines.map((line, index) => (
            <li key={`${line}-${index}`}>{line}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-[12px] text-muted-foreground">
        {baseline.toolInsightCount} tool row
        {baseline.toolInsightCount === 1 ? "" : "s"} and{" "}
        {baseline.workflowInsightCount} workflow row
        {baseline.workflowInsightCount === 1 ? "" : "s"} were recorded
        {baseline.clipped ? "; the list above is clipped" : ""}. These rows are
        not attached to the counts above — they were produced from a different
        reading of this run.
      </p>
    </div>
  );
}

export function UnifiedFindingsPanel({
  analysis,
  snapshot,
  findings,
  provenance,
  observationState,
  observationCoverage,
  mode,
  analyze,
  build,
  backendUnavailableNote,
  executionIssues,
  scopeControl,
  context,
  onOpenEvidence,
  iterationRows,
  fallback,
}: UnifiedFindingsPanelProps) {
  const [showMore, setShowMore] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const coverageTrigger = useRef<HTMLButtonElement>(null);
  // Ordering is a MEASURED fact (actionability, severity, affected count).
  // Whether a model happened to narrate a finding is not, and must not move
  // a bigger problem below a smaller one.
  const sorted = useMemo(() => sortFindingsForDisplay(findings), [findings]);
  const provenanceById = useMemo(
    () => new Map(provenance.map((p) => [p.candidateId, p])),
    [provenance],
  );
  const [lead, ...secondary] = sorted;
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
  const coverageText = discovery
    ? `Reviewed ${discovery.reviewedFailedIterations} of ${
        discovery.totalFailedIterations
      } failed iterations and ${
        discovery.reviewedIterations - discovery.reviewedFailedIterations
      } passing examples.`
    : observationCoverage
      ? `Evidence covers ${observationCoverage.analyzed} of ${
          observationCoverage.total
        } iterations.${
          observationCoverage.gradedCount > 0
            ? ` ${observationCoverage.gradedCount} graded.`
            : ""
        }`
      : null;
  const summaryProps = {
    view: mode === "ai" ? ("ai" as const) : ("deterministic" as const),
    context,
    onOpenEvidence,
    iterationRows,
  };

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
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            disabled={!analyze.available || analyze.pending}
            onClick={analyze.onRun}
            data-testid="unified-findings-analyze"
          >
            {analyze.pending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="size-3.5" aria-hidden="true" />
            )}
            {analyze.pending
              ? analysis?.phase === "reading"
                ? `Reading iterations ${analysis.progress.done}/${analysis.progress.total}`
                : analysis?.phase === "grouping"
                  ? "Grouping problems…"
                  : analysis?.phase === "checking"
                    ? "Checking evidence…"
                    : "Analyzing…"
              : enrichment?.status === "ready"
                ? "Analyze again"
                : "Analyze findings"}
          </Button>
          {lead ? (
            <CopyFindingPrompt key={lead.id} finding={lead} context={context} />
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
      {executionIssues || backendUnavailableNote || analyze.error ? (
        <div className="mb-5 space-y-3">
          {executionIssues}
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
              {lead ? " Existing findings are still available below." : ""}
            </StateNote>
          ) : null}
        </div>
      ) : null}
      {enrichment?.status === "stale" ? (
        <div className="mb-5">
          <StateNote tone="warning" testId="unified-findings-stale-enrichment">
            The evidence changed. Analyze again to update the suggested fixes.
          </StateNote>
        </div>
      ) : null}
      {!snapshot ? (
        fallback !== undefined && !analyze.pending && !build?.pending ? (
          fallback
        ) : (
          <div className="space-y-2">
            <StateNote testId="unified-findings-no-snapshot">
              {analyze.pending || build?.pending
                ? "Reading this run’s recorded evidence…"
                : build?.available
                  ? "Findings have not been built for this run yet. Building reads the recorded evidence; it does not call a model."
                  : "Analyze this run to see what broke, suggested fixes, and supporting evidence."}
            </StateNote>
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
      ) : lead ? (
        <div data-testid="unified-findings-list">
          <FindingSummary
            key={lead.id}
            finding={lead}
            provenance={provenanceById.get(lead.id) ?? null}
            lead
            {...summaryProps}
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
            ? "There isn’t enough recorded evidence to explain this run. See coverage details below."
            : incomplete
              ? "No supported finding yet. Evidence is incomplete; this does not mean the run passed."
              : mode === "ai"
                ? "Analysis found no supported issue to report. This does not change the run’s results."
                : "No issue found in the recorded checks. Analyze findings to look for patterns and suggested fixes."}
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
                `${count} iterations ${humanExclusion(reason)}`,
            )
            .join("; ")}
          .
        </p>
      ) : null}
      {snapshot && coverageText ? (
        <p
          className="mt-5 text-xs leading-6 text-muted-foreground"
          data-testid="unified-findings-coverage-summary"
        >
          {coverageText}
          {incomplete ? " Some evidence is incomplete." : ""}{" "}
          <button
            type="button"
            className="min-h-8 font-medium text-foreground underline-offset-4 hover:underline"
            onClick={() => setCoverageOpen(true)}
            ref={coverageTrigger}
          >
            Coverage details
          </button>
        </p>
      ) : null}
      {secondary.length > 0 ? (
        <div className="mt-5 border-t border-border/60">
          <button
            type="button"
            className="flex min-h-11 w-full items-center gap-2 py-3 text-left text-xs hover:text-foreground/80 focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => setShowMore(!showMore)}
            aria-expanded={showMore}
            data-testid="unified-findings-toggle-all"
          >
            <ChevronRight
              className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
                showMore ? "rotate-90" : ""
              }`}
              aria-hidden="true"
            />
            <span>
              {secondary.length} more{" "}
              {secondary.length === 1 ? "finding" : "findings"}
              {secondary.length === 1 ? ` · ${secondary[0].title}` : ""}
            </span>
          </button>
          {showMore ? (
            <div className="divide-y divide-border/60">
              {secondary.map((f) => (
                <div key={f.id} className="py-5">
                  <FindingSummary
                    finding={f}
                    provenance={provenanceById.get(f.id) ?? null}
                    {...summaryProps}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <Sheet open={coverageOpen} onOpenChange={setCoverageOpen}>
        <SheetContent
          className="w-full overflow-y-auto sm:max-w-[620px]"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            coverageTrigger.current?.focus();
          }}
        >
          <SheetHeader className="px-6 pt-6 pr-12">
            <SheetTitle className="text-lg">Analysis coverage</SheetTitle>
            <SheetDescription>
              What this analysis used from the selected run.
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-6 px-6 pb-8 text-sm leading-relaxed">
            {discovery ? (
              <div data-testid="unified-findings-enrichment-note">
                <p>{coverageText}</p>
                <p className="mt-3">
                  {discovery.missingTraces} transcripts unavailable or outside
                  the read limit; {discovery.truncatedTraces} transcripts
                  shortened; {discovery.omittedEvidence} evidence records
                  omitted for size.
                </p>
                <p className="mt-3 text-muted-foreground">
                  Counts come from distinct cited iterations. Grouping and
                  suggested causes are AI interpretations, not a proven cause or
                  a run-wide failure rate.
                </p>
              </div>
            ) : snapshot ? (
              <CoverageLine
                state={observationState}
                coverage={observationCoverage}
                omittedGroups={snapshot.omittedGroups}
                trim={snapshot.trim ?? null}
              />
            ) : null}
            {enrichment?.status === "ready" ? (
              <p className="text-xs text-muted-foreground">
                Generated {new Date(enrichment.generatedAt).toLocaleString()} ·{" "}
                {enrichment.modelUsed}. {enrichment.acceptedCount} findings with
                verified citations.{" "}
                {enrichment.rejectedCount > 0
                  ? `${enrichment.rejectedCount} proposals rejected for invalid or duplicate citations or missing guidance.`
                  : ""}
              </p>
            ) : null}
            {snapshot?.baseline ? (
              <details className="border-t border-border/60 pt-4">
                <summary className="cursor-pointer font-medium">
                  Previous analysis
                </summary>
                <div className="mt-4">
                  <BaselineView baseline={snapshot.baseline} />
                </div>
              </details>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
