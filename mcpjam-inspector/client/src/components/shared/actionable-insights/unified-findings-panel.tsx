/**
 * The unified-findings panel (EXPERIMENT).
 *
 * One lead finding, a short list of secondary ones, and a comparison control
 * that exists for this branch only — it is how the experiment is judged, not
 * a proposal for the shipped product.
 *
 * PURE PRESENTATION. Every piece of state arrives as a prop, so the same
 * component renders from a live Convex subscription in the app and from a
 * replay artifact in the offline preview. If those two ever disagree it is
 * because a component differs, never because the lab computed findings its
 * own way.
 *
 * The two operations are deliberately different words:
 *  - **Build findings** is deterministic and free. It says so on the button's
 *    own line, because "analyze" reads as "spend money" to anyone who has
 *    used the old insights.
 *  - **Add AI explanation** is metered. It never runs on mount, never on a
 *    view switch, and never when evidence is opened.
 *
 * Their loading and error states are separate. A model failure leaves every
 * observation on screen — that is the property the whole experiment is
 * testing, so it is not allowed to be incidental.
 */
import { useMemo, useState } from "react";
import { Loader2, Sparkles, Hammer, AlertTriangle } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import {
  sortFindingsForDisplay,
  type ActionableFinding,
  type InsightsFindingProvenance,
  type InsightsObservationCoverage,
  type InsightsObservationState,
  type UnifiedFindingsExperiment,
} from "@/lib/insights-envelope-api";
import type { FindingPromptContext } from "./finding-prompts";
import { FindingSummary } from "./finding-summary";
import type { FindingEvidenceLocator } from "./finding-evidence";
import type { FindingView } from "./finding-provenance";

const SECONDARY_VISIBLE = 4;

export type UnifiedFindingsMode = "deterministic" | "ai" | "baseline";

export type UnifiedFindingsPanelProps = {
  /** `null` ⇒ no snapshot has been built for this run yet. */
  snapshot: UnifiedFindingsExperiment["snapshot"];
  /** The current view's findings. The caller owns the selection so the panel
   * never re-derives which array a mode means. */
  findings: readonly ActionableFinding[];
  provenance: readonly InsightsFindingProvenance[];
  observationState: InsightsObservationState | null;
  observationCoverage: InsightsObservationCoverage | null;
  mode: UnifiedFindingsMode;
  onModeChange: (mode: UnifiedFindingsMode) => void;
  /** Separate lifecycle per operation — never one shared spinner. */
  build: {
    available: boolean;
    pending: boolean;
    error: string | null;
    onRun: () => void;
  };
  enrich: {
    available: boolean;
    pending: boolean;
    error: string | null;
    onRun: () => void;
  };
  /** Set when the paired backend branch is not deployed. */
  backendUnavailableNote?: string | null;
  context?: FindingPromptContext;
  onOpenEvidence?: (locator: FindingEvidenceLocator) => void;
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
      className={cn(
        "rounded-md border px-3 py-2 text-[12.5px] leading-relaxed",
        tone === "destructive"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : tone === "warning"
          ? "border-warning/40 bg-warning/10 text-foreground"
          : "border-border/60 bg-muted/30 text-muted-foreground",
      )}
      data-testid={testId}
    >
      {children}
    </p>
  );
}

function ModeTabs({
  mode,
  onModeChange,
  hasAi,
  hasBaseline,
}: {
  mode: UnifiedFindingsMode;
  onModeChange: (mode: UnifiedFindingsMode) => void;
  hasAi: boolean;
  hasBaseline: boolean;
}) {
  const tabs: Array<{
    value: UnifiedFindingsMode;
    label: string;
    enabled: boolean;
    hint: string;
  }> = [
    {
      value: "deterministic",
      label: "Observations",
      enabled: true,
      hint: "Built from recorded evidence. No AI.",
    },
    {
      value: "ai",
      label: "With AI explanation",
      enabled: hasAi,
      hint: hasAi
        ? "The same observations, with model-written prose layered on."
        : "No AI explanation has been generated for this snapshot.",
    },
    {
      value: "baseline",
      label: "Previous analysis",
      enabled: hasBaseline,
      hint: hasBaseline
        ? "The analysis that existed before this snapshot was built."
        : "No previous analysis was recorded for this run.",
    },
  ];
  return (
    <div
      className="flex flex-wrap gap-1 rounded-md border border-border/60 bg-muted/30 p-1"
      role="tablist"
      aria-label="Findings comparison view"
      data-testid="unified-findings-modes"
    >
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={mode === tab.value}
          disabled={!tab.enabled}
          title={tab.hint}
          onClick={() => onModeChange(tab.value)}
          className={cn(
            "rounded px-2.5 py-1 text-[12px] transition-colors",
            mode === tab.value
              ? "bg-background text-foreground shadow-2xs"
              : "text-muted-foreground hover:text-foreground",
            !tab.enabled &&
              "cursor-not-allowed opacity-50 hover:text-muted-foreground",
          )}
          data-testid={`unified-findings-mode-${tab.value}`}
        >
          {tab.label}
        </button>
      ))}
    </div>
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
  const exclusions = Object.entries(coverage.exclusions).filter(
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
  chainUnverified: "whose reported chain failed integrity",
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

export function UnifiedFindingsPanel(props: UnifiedFindingsPanelProps) {
  const {
    snapshot,
    findings,
    provenance,
    observationState,
    observationCoverage,
    mode,
    onModeChange,
    build,
    enrich,
    backendUnavailableNote,
    context,
    onOpenEvidence,
  } = props;
  const [showAll, setShowAll] = useState(false);

  const provenanceById = useMemo(() => {
    const map = new Map<string, InsightsFindingProvenance>();
    for (const row of provenance) map.set(row.candidateId, row);
    return map;
  }, [provenance]);

  const sorted = useMemo(() => sortFindingsForDisplay(findings), [findings]);

  const view: FindingView = mode === "ai" ? "ai" : "deterministic";
  const [lead, ...secondary] = sorted;
  const visibleSecondary = showAll
    ? secondary
    : secondary.slice(0, SECONDARY_VISIBLE);

  return (
    <div className="space-y-3" data-testid="unified-findings-panel">
      {backendUnavailableNote ? (
        <StateNote tone="warning" testId="unified-findings-backend-missing">
          <AlertTriangle
            className="mr-1 inline size-3.5 align-[-2px]"
            aria-hidden="true"
          />
          {backendUnavailableNote}
        </StateNote>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          disabled={!build.available || build.pending}
          onClick={build.onRun}
          data-testid="unified-findings-build"
        >
          {build.pending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Hammer className="size-3.5" aria-hidden="true" />
          )}
          {snapshot ? "Rebuild findings" : "Build findings"}
        </Button>
        <span className="text-[12px] text-muted-foreground">
          Reads this run&apos;s recorded evidence. Does not use AI.
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto h-8"
          disabled={!enrich.available || enrich.pending || !snapshot}
          onClick={enrich.onRun}
          data-testid="unified-findings-enrich"
        >
          {enrich.pending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="size-3.5" aria-hidden="true" />
          )}
          Add AI explanation
        </Button>
      </div>

      {build.error ? (
        <StateNote tone="destructive" testId="unified-findings-build-error">
          Building findings failed: {build.error}
        </StateNote>
      ) : null}
      {enrich.error ? (
        <StateNote tone="destructive" testId="unified-findings-enrich-error">
          The AI explanation failed: {enrich.error}
          {snapshot
            ? " The observations below are unaffected — they were never produced by a model."
            : ""}
        </StateNote>
      ) : null}

      {!snapshot ? (
        <StateNote testId="unified-findings-no-snapshot">
          {build.pending
            ? "Building findings from this run's recorded evidence…"
            : "Findings have not been built for this run. Use Build findings above — it reads the recorded evidence and does not use AI."}
        </StateNote>
      ) : null}

      {snapshot ? (
        <>
          <ModeTabs
            mode={mode}
            onModeChange={onModeChange}
            hasAi={snapshot.enrichment?.status === "ready"}
            hasBaseline={snapshot.baseline !== null}
          />

          {snapshot.enrichment?.status === "stale" ? (
            <StateNote
              tone="warning"
              testId="unified-findings-stale-enrichment"
            >
              A previous AI explanation was written against older evidence and
              is not being shown. Rebuilding changed what these findings
              describe, so the old advice is not reattached to the new counts.
            </StateNote>
          ) : null}

          {mode === "baseline" && snapshot.baseline ? (
            <BaselineView baseline={snapshot.baseline} />
          ) : mode === "baseline" ? (
            <StateNote testId="unified-findings-no-baseline">
              No previous analysis. This run had no stored analysis when these
              findings were built.
            </StateNote>
          ) : observationState === "unavailable" ? (
            <StateNote tone="warning" testId="unified-findings-unavailable">
              Nothing in this run could be measured. Every iteration was
              excluded — see the coverage below — so there is no honest finding
              to show, which is different from finding nothing wrong.
            </StateNote>
          ) : sorted.length === 0 ? (
            <StateNote testId="unified-findings-empty">
              No findings.{" "}
              {observationState === "partial"
                ? "Part of this run could not be measured, so treat this as incomplete rather than clean."
                : "The evidence this run recorded does not justify one."}
            </StateNote>
          ) : (
            <div className="space-y-2.5" data-testid="unified-findings-list">
              {lead ? (
                <FindingSummary
                  finding={lead}
                  provenance={provenanceById.get(lead.id) ?? null}
                  view={view}
                  lead
                  {...(context ? { context } : {})}
                  {...(onOpenEvidence ? { onOpenEvidence } : {})}
                />
              ) : null}
              {visibleSecondary.map((finding) => (
                <FindingSummary
                  key={finding.id}
                  finding={finding}
                  provenance={provenanceById.get(finding.id) ?? null}
                  view={view}
                  {...(context ? { context } : {})}
                  {...(onOpenEvidence ? { onOpenEvidence } : {})}
                />
              ))}
              {secondary.length > SECONDARY_VISIBLE ? (
                <button
                  type="button"
                  className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => setShowAll((value) => !value)}
                  data-testid="unified-findings-toggle-all"
                >
                  {showAll
                    ? "Show fewer"
                    : `Show all ${sorted.length} findings`}
                </button>
              ) : null}
            </div>
          )}

          {mode === "ai" && snapshot.enrichment?.status === "ready" ? (
            <StateNote testId="unified-findings-enrichment-note">
              AI explanation generated{" "}
              {new Date(snapshot.enrichment.generatedAt).toLocaleString()} by{" "}
              <code className="font-code">{snapshot.enrichment.modelUsed}</code>
              . {snapshot.enrichment.acceptedCount} explanation
              {snapshot.enrichment.acceptedCount === 1 ? "" : "s"} matched a
              finding
              {snapshot.enrichment.rejectedCount > 0
                ? `; ${snapshot.enrichment.rejectedCount} row${
                    snapshot.enrichment.rejectedCount === 1 ? " was" : "s were"
                  } rejected for naming a finding that does not exist or naming one twice`
                : ""}
              . Counts, evidence and targets above are unchanged by it.
            </StateNote>
          ) : null}

          <CoverageLine
            state={observationState}
            coverage={observationCoverage}
            omittedGroups={snapshot.omittedGroups}
            trim={snapshot.trim ?? null}
          />
        </>
      ) : null}
    </div>
  );
}
