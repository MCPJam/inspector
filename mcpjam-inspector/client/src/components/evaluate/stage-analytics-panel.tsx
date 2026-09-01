/**
 * The stage-analytics panel on the Evaluate (New) suite page (D5c).
 *
 * WHERE the chain stopped — not why, and never a root cause. Each run's
 * document says where trials fell out of the six-stage chain and whether that
 * differs by intent, model or host; it explains measured behavior and never
 * replaces the run's verdict, which stays the verdict policy's to decide.
 *
 * ── Why this is not the shared `StageFunnel` ─────────────────────────────────
 *
 * `components/shared/user-value-chain/StageFunnel.tsx` renders an OLDER
 * projection: a precomputed `passRate`, no reach/measured distinction, and a
 * derivation-lifecycle exclusion vocabulary (`absent`/`deriving`/`stale`/
 * `failed`) that is deliberately incompatible with `EvalStageExclusions`.
 * Forcing this document through it would discard exactly the three-rate
 * structure D5c exists to show. So this renders `EvalStageTally` directly —
 * while copying that component's honest-state conventions, which are the part
 * worth sharing: words instead of a bar when nothing was measured, named
 * exclusions, and a population named on every count.
 *
 * ── Run-scoped, never aggregated ─────────────────────────────────────────────
 *
 * Each row is ONE run's complete document, and there is no cross-run merge in
 * the SDK on purpose. So this lists the runs and renders the SELECTED one.
 * Paging browses further back; it never accumulates into a combined funnel.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import type {
  EvalStageAnalyticsV1,
  UserValueStage,
} from "@mcpjam/sdk/contract";
import {
  evalSurfaceCardClass,
  evalSurfaceHeaderClass,
} from "../evals/eval-surface-chrome";
import { useEvalSuiteStageAnalytics } from "@/hooks/use-eval-suite-stage-analytics";
import {
  NOT_MEASURED_LABEL,
  deriveStageAnalyticsPanelState,
  excludedDetailSummary,
  overallSlice,
  slicesOfDimension,
  toRunHeaderView,
  toSetupView,
  toSliceView,
  type SliceView,
  type StageRateView,
  type StageRowView,
} from "./stage-analytics-model";
import { StageChainCards } from "./stage-chain-cards";
import { StageDetailCard } from "./stage-detail-card";
import { defaultSelectedStage, toStageCardViews } from "./stage-chain-model";
import { RunLevelFindingsLine, StageFindingsCard } from "./stage-findings-card";
import { useStageFindings } from "./use-stage-findings";
import type { EvalDecisionSummaryStore } from "@/lib/evals/eval-decision-summary-store";

/**
 * The bits of a run row the findings read needs.
 *
 * Structural rather than `EvalSuiteRun`, so this panel does not take a
 * dependency on the whole run projection to read six fields off it — and so a
 * caller holding a narrower row can still pass one.
 */
export interface StageAnalyticsRunRow {
  _id: string;
  status: string;
  result?: string | null;
  completedAt?: number | null;
  verdictPolicyVersion?: unknown;
  verdictSummary?: unknown;
  goalCompletionStatus?: string | null;
}

function formatCompletedAt(epochMs: number | null): string {
  if (epochMs === null) return "no completion stamp";
  return new Date(epochMs).toLocaleString();
}

/**
 * One rate, with its arithmetic and its exclusions. Words when unmeasured.
 *
 * Exported for the stage detail card, which shows the same three rates for the
 * selected stage. Re-implementing it there would put a second renderer in
 * front of the one rule this whole surface rests on — words instead of a bar
 * when the denominator is zero — and the second copy is the one that gets it
 * wrong the day somebody "simplifies" a `null` check.
 */
export function RateCell({ rate }: { rate: StageRateView }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground">{rate.label}</span>
      {rate.percent === null ? (
        // The words, not a zero. A zero DENOMINATOR is not a measurement.
        <span className="text-[11px] text-muted-foreground italic">
          {NOT_MEASURED_LABEL}
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">{rate.percent}</span>{" "}
          {/* The counts travel with the rate, always. */}
          <span aria-label={`${rate.arithmetic} eligible`}>
            ({rate.arithmetic})
          </span>
        </span>
      )}
      <div
        className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-muted"
        role="presentation"
      >
        {rate.fraction === null ? null : (
          <div
            className="h-full rounded-full bg-emerald-500"
            style={{ width: `${rate.fraction * 100}%` }}
          />
        )}
      </div>
      {rate.exclusions.length > 0 ? (
        <p className="text-[10px] text-muted-foreground/80">
          Excluded: {rate.exclusions.join("; ")}
        </p>
      ) : null}
    </div>
  );
}

function StageRow({ stage }: { stage: StageRowView }) {
  return (
    <li className="py-2" data-stage={stage.stage} data-testid="stage-row">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          {stage.label}
        </span>
        {stage.latency ? (
          // Unit AND basis: a duration without its basis is a claim, not a
          // measurement.
          <span className="text-[10px] text-muted-foreground">
            {stage.latency}
          </span>
        ) : null}
      </div>
      <div className="mt-1 grid gap-3 sm:grid-cols-3">
        <RateCell rate={stage.reach} />
        <RateCell rate={stage.coverage} />
        <RateCell rate={stage.pass} />
      </div>
      {stage.reachUnknown > 0 || stage.notApplicable > 0 ? (
        <p className="mt-1 text-[10px] text-muted-foreground/80">
          {/* Three different facts, kept as three sentences. None is a failure. */}
          {stage.reachUnknown} captured nothing (reach undecidable),{" "}
          {stage.notApplicable} not applicable to the case. Neither is counted
          as a drop-off.
        </p>
      ) : null}
      {stage.reasons.length > 0 ? (
        // ONE LINE EACH, not comma-joined. The labels are "…because <fragment>"
        // sentences ("nothing eligible for that stage was captured"), and three
        // of them spliced together with commas reads as one long claim about
        // one population rather than three separate counts.
        <ul className="mt-1 space-y-0.5" data-testid="stage-reasons">
          {stage.reasons.map((entry) => (
            <li
              key={entry.reason}
              data-reason={entry.reason}
              className="text-[10px] text-muted-foreground/80"
            >
              {entry.count} — {entry.label}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SliceBlock({ slice }: { slice: SliceView }) {
  return (
    <div
      className="rounded-md border border-border/60 p-3"
      data-testid="stage-slice"
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-xs font-medium text-foreground">
            {slice.title}
          </span>
          {slice.subtitle ? (
            <span className="text-[10px] text-muted-foreground">
              {slice.subtitle}
            </span>
          ) : null}
        </div>
        {/* Every count names its population. */}
        <span className="text-[10px] text-muted-foreground">
          {slice.includedTrials} trials in this slice
        </span>
      </div>
      {slice.exclusions.length > 0 ? (
        <p className="mt-1 text-[10px] text-muted-foreground/80">
          Excluded: {slice.exclusions.join("; ")}
        </p>
      ) : null}
      {slice.failureCategories.length > 0 ? (
        <p
          className="mt-1 text-[10px] text-muted-foreground/80"
          data-testid="stage-slice-failure-categories"
        >
          {/* Comma-joined here and NOT above, because these labels are noun
              phrases ("tool selection", "server data") rather than sentences. */}
          {slice.failureCategories
            .map((entry) => `${entry.label} (${entry.count})`)
            .join(", ")}
        </p>
      ) : null}
      <ul className="mt-1 divide-y divide-border/50">
        {slice.stages.map((stage) => (
          <StageRow key={stage.stage} stage={stage} />
        ))}
      </ul>
    </div>
  );
}

function SliceGroup({ title, slices }: { title: string; slices: SliceView[] }) {
  if (slices.length === 0) return null;
  return (
    <details className="mt-3" data-testid={`stage-slice-group-${title}`}>
      {/* COLLAPSED by default. The markup inside is unchanged — this is a
          disclosure around the existing group, not a rewrite of it. A reader
          who has not yet found the break in the chain is not asking whether it
          differs by host. */}
      <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </summary>
      <div className="mt-1.5 grid gap-2">
        {slices.map((slice) => (
          <SliceBlock key={slice.key} slice={slice} />
        ))}
      </div>
    </details>
  );
}

/**
 * One run's document, rendered from PROPS alone.
 *
 * Exported so a second surface (the eval run detail) can render the canonical
 * document without inheriting this file's suite-scoped fetching. The panel
 * below self-fetches a suite and lists its runs; a run detail already has its
 * run and needs none of that. Reusing the PANEL there would drag a suite
 * listing, its paging and its run selector onto a page that has exactly one
 * run — and would make the run detail's population quietly a suite's.
 *
 * Pure props, no hooks, no queries: the same document renders identically on
 * both surfaces, which is the whole point of there being one contract.
 */
export function RunDocument({
  row,
  renderFindings,
  runLevelFindings,
}: {
  row: EvalStageAnalyticsV1;
  /**
   * The evidence for one stage's failures, when a caller can join it.
   *
   * A RENDER PROP, so this component stays pure props with no hooks and no
   * queries — the property that lets the same document render identically on
   * the suite page and the run page. The diagnostics that fill it come from a
   * different read with its own loading and failure states, and every rate
   * above is true whether or not that read landed.
   */
  renderFindings?: (stage: UserValueStage) => ReactNode;
  /**
   * A line under the cards for the non-passing trials no stage accounts for.
   *
   * Its own slot rather than part of `renderFindings`, because it is a
   * different claim about a different population: these trials did not pass
   * and the chain does not say where, so they sit under the row rather than
   * inside any one stage.
   */
  runLevelFindings?: ReactNode;
}) {
  const header = toRunHeaderView(row);
  const overall = overallSlice(row);
  const intents = slicesOfDimension(row, "intent");
  const models = slicesOfDimension(row, "model");
  const hosts = slicesOfDimension(row, "host");
  const setup = row.setup.map(toSetupView);

  const overallView = useMemo(
    () => (overall ? toSliceView(overall, 0) : null),
    [overall],
  );
  const cards = useMemo(
    () => (overallView ? toStageCardViews(overall!.stages) : []),
    [overallView, overall],
  );

  /**
   * Which stage's detail is open.
   *
   * Local state, and held HERE rather than by either caller, so both mounts of
   * this document — the suite panel and the run-detail slot — inherit the
   * behaviour without either one knowing the other exists.
   *
   * `undefined` means "the reader has not chosen yet", which is a different
   * thing from the `null` they get by closing a card. Without that
   * distinction, auto-selecting the first break would fight every attempt to
   * close it.
   */
  const [chosenStage, setChosenStage] = useState<
    UserValueStage | null | undefined
  >(undefined);
  const documentIdentity = row.runId;
  const previousIdentity = useRef(documentIdentity);
  if (previousIdentity.current !== documentIdentity) {
    // A different run is a different chain. Carrying a selection across would
    // open a stage the new run may not have broken at.
    previousIdentity.current = documentIdentity;
    if (chosenStage !== undefined) setChosenStage(undefined);
  }

  const selectedStage =
    chosenStage === undefined ? defaultSelectedStage(cards) : chosenStage;
  const selectedRow =
    overallView?.stages.find((stage) => stage.stage === selectedStage) ?? null;

  const setSelectedStage = (
    update: (current: UserValueStage | null) => UserValueStage | null,
  ) => setChosenStage(update(selectedStage));

  return (
    <div data-testid="stage-analytics-document">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-medium text-foreground">
          {formatCompletedAt(header.completedAt)}
        </span>
        {header.provisional ? (
          <span
            className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-400"
            data-testid="stage-analytics-provisional"
          >
            {header.materializationLabel}
          </span>
        ) : null}
        <span className="text-[10px] text-muted-foreground">
          {header.populationLabel}
        </span>
      </div>

      {header.disclosures.length > 0 ? (
        <ul
          className="mt-1.5 space-y-0.5"
          data-testid="stage-analytics-disclosures"
        >
          {header.disclosures.map((line) => (
            <li key={line} className="text-[10px] text-muted-foreground/80">
              {line}
            </li>
          ))}
        </ul>
      ) : null}

      {/* The fine-grained exclusion reasons, COLLAPSED.

          The coarse "Excluded: 1 never produced a comparable observation" line
          is already in the disclosures above, and these say the same trials
          over again at a finer grain — two lines that look like two findings
          and are one. Collapsed, and labelled as "why", so the second is
          plainly the first explained rather than more of it.

          Absent entirely when nothing was excluded: a control that opens onto
          nothing is a worse answer than no control. */}
      {header.excludedDetail.length > 0 ? (
        <details
          className="mt-1.5"
          data-testid="stage-analytics-excluded-detail"
        >
          <summary className="cursor-pointer text-[10px] text-muted-foreground/80">
            {excludedDetailSummary(header)}
          </summary>
          <ul className="mt-1 space-y-0.5 pl-3">
            {header.excludedDetail.map((entry) => (
              <li
                key={entry.key}
                data-exclusion={entry.key}
                className="text-[10px] text-muted-foreground/80"
              >
                {entry.count} — {entry.label}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {overallView ? (
        <section className="mt-3">
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Overall — where the chain stopped
          </h4>
          {/* The D9/D5c boundary, said in the UI's own words rather than left
              as an internal rule. A reader looking at six health chips has to
              know they are not a second verdict — otherwise a `failed` chip on
              a run whose verdict is `passed` reads as a contradiction, when in
              fact policy v2 lets a case pass with a failing trial in it. */}
          <p className="mt-0.5 text-[10px] text-muted-foreground/80">
            Stage health explains the request-delivery path; it does not
            determine the evaluation verdict.
          </p>
          <div className="mt-1.5">
            <StageChainCards
              cards={cards}
              selected={selectedStage}
              onSelect={(stage) =>
                // Toggling off returns the reader to the row. A second click
                // on the open card should close it, not re-open it.
                setSelectedStage((current) =>
                  current === stage ? null : stage,
                )
              }
            />
            {runLevelFindings ?? null}
            {selectedRow ? (
              <StageDetailCard
                stage={selectedRow}
                {...(renderFindings
                  ? { findings: renderFindings(selectedRow.stage) }
                  : {})}
              />
            ) : null}
            {/* The full three-rate table for all six stages, kept VERBATIM and
                collapsed. The cards answer "where did it break"; this is the
                complete measurement the cards summarize, and the honesty rules
                the existing tests pin live in here. */}
            <details
              className="mt-2"
              data-testid="stage-analytics-overall-rows"
            >
              <summary className="cursor-pointer text-[10px] text-muted-foreground/80">
                All six stages, with reach, coverage and pass rates
              </summary>
              <div className="mt-1.5">
                <SliceBlock slice={overallView} />
              </div>
            </details>
          </div>
        </section>
      ) : null}

      {/* The marginals keep their existing markup exactly, behind collapsed
          expanders. They answer a follow-up question ("is this one model?"),
          and a reader who has not yet located the break in the chain is not
          asking it. */}
      <SliceGroup title="By intent" slices={intents} />
      <SliceGroup title="By model" slices={models} />
      <SliceGroup title="By host" slices={hosts} />

      {setup.length > 0 ? (
        <details className="mt-3" data-testid="stage-analytics-setup">
          <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Setup
          </summary>
          <div className="mt-1.5 grid gap-2">
            {setup.map((phase) => (
              <div
                key={phase.phase}
                className="rounded-md border border-border/60 p-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">
                    {phase.label}
                  </span>
                  {phase.latency ? (
                    <span className="text-[10px] text-muted-foreground">
                      {phase.latency}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {/* Attempts are counted once per run; impacted trials are
                      counted distinctly and MAY exceed them. */}
                  {phase.uniqueAttempts} attempts, {phase.failedAttempts} failed
                  ({phase.serverAttributedFailures} attributed to the server),
                  blocking {phase.impactedTrials} trials in this run
                </p>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export function StageAnalyticsPanel({
  projectId,
  suiteId,
  runCount,
  runsLoading,
  runs = [],
  onRunClick,
  decisionSummaryEnabled = false,
  decisionStore,
}: {
  projectId: string | null | undefined;
  suiteId: string | null | undefined;
  /** How many runs this suite has — the legacy/empty distinction. */
  runCount: number;
  runsLoading: boolean;
  /**
   * The suite's run rows, for the SELECTED document only.
   *
   * The diagnostics read needs the run's status and revision, which the
   * analytics document does not carry. Only the selected row is ever read: one
   * document is on screen and reading D9 for every run in the list would spend
   * a request per row to fill a card nobody opened.
   */
  runs?: StageAnalyticsRunRow[];
  /** Open a run. The suite page has no deep trace focus; the run page does. */
  onRunClick?: (runId: string) => void;
  /**
   * Read D9's per-trial diagnostics for the selected run. OFF by default: with
   * it false this panel issues no decision-summary requests at all.
   */
  decisionSummaryEnabled?: boolean;
  /** Test seam, threaded to the shared LRU store. */
  decisionStore?: EvalDecisionSummaryStore;
}) {
  const {
    status,
    rows,
    error,
    canLoadMore,
    isLoadingMore,
    pageError,
    loadMore,
    retryFailedPage,
  } = useEvalSuiteStageAnalytics({ projectId, suiteId });

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const panelState = useMemo(
    () =>
      deriveStageAnalyticsPanelState({
        status,
        rows,
        error,
        runCount,
        runsLoading,
      }),
    [status, rows, error, runCount, runsLoading],
  );

  // Default to the newest run, and fall back to it whenever the selected run
  // leaves the list (a filter change, a fresh walk).
  const selected =
    rows.find((row) => row.runId === selectedRunId) ?? rows[0] ?? null;

  // The run row behind the selected document. `null` when this surface was not
  // given the run list, which keeps the findings read off rather than guessing
  // a status the analytics document does not carry.
  const selectedRun = selected
    ? (runs.find((run) => run._id === selected.runId) ?? null)
    : null;
  const findings = useStageFindings({
    projectId,
    analytics: selected,
    run: selectedRun,
    enabled: decisionSummaryEnabled,
    canOpenTrial: Boolean(onRunClick),
    ...(decisionStore ? { store: decisionStore } : {}),
  });

  return (
    <section
      className={cn(evalSurfaceCardClass, "overflow-hidden")}
      data-testid="suite-detail-stage-analytics"
    >
      <div className={cn(evalSurfaceHeaderClass, "px-4 py-3")}>
        <h3 className="text-sm font-medium text-foreground">Stage analytics</h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Where trials stopped in the user-value chain, per run. Explains
          measured behavior; it does not decide the run&apos;s verdict.
        </p>
      </div>

      <div className="px-4 py-3">
        {panelState.kind === "loading" ? (
          <p
            className="flex items-center gap-2 text-xs text-muted-foreground"
            data-testid="stage-analytics-loading"
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading stage analytics…
          </p>
        ) : null}

        {panelState.kind === "unsupported" ? (
          // A SERVICE state, visibly distinct from "there is nothing here".
          // An empty chart would read as "measured, and it was all zero".
          <p
            className="text-xs text-muted-foreground"
            data-testid="stage-analytics-unsupported"
          >
            Stage analytics could not be loaded, so this run&apos;s chain is not
            measured here. {panelState.message}
          </p>
        ) : null}

        {panelState.kind === "error" ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="stage-analytics-error"
          >
            {panelState.message}
          </p>
        ) : null}

        {panelState.kind === "empty" ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="stage-analytics-empty"
          >
            No completed runs yet.
          </p>
        ) : null}

        {panelState.kind === "unmeasuredLegacy" ? (
          // NOT a zero and NOT empty: these runs finished before the chain was
          // measured, and there is no honest way to reconstruct it after the
          // fact.
          <p
            className="text-xs text-muted-foreground"
            data-testid="stage-analytics-unmeasured-legacy"
          >
            These {panelState.runCount} runs predate stage analytics, so their
            chain was never measured. Runs from here on will be.
          </p>
        ) : null}

        {panelState.kind === "ready" && selected ? (
          <>
            {rows.length > 1 ? (
              <div
                className="mb-3 flex flex-wrap gap-1.5"
                data-testid="stage-analytics-run-list"
              >
                {rows.map((row) => (
                  <button
                    key={row.runId}
                    type="button"
                    onClick={() => setSelectedRunId(row.runId)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[10px]",
                      row.runId === selected.runId
                        ? "border-foreground/40 bg-muted text-foreground"
                        : "border-border/60 text-muted-foreground",
                    )}
                  >
                    {formatCompletedAt(row.runCompletedAt ?? null)}
                    {row.materializationState === "provisional"
                      ? " · provisional"
                      : ""}
                  </button>
                ))}
              </div>
            ) : null}

            <RunDocument
              row={selected}
              renderFindings={(stage) => (
                <StageFindingsCard
                  state={findings}
                  stage={stage}
                  // "Open run", not "View trace": deep trace focus exists only
                  // on the run page, and a button promising it here would land
                  // a reader on a page with nothing opened.
                  openLabel="Open run"
                  {...(onRunClick
                    ? { onOpenTrial: (target) => onRunClick(target.runId) }
                    : {})}
                />
              )}
              runLevelFindings={<RunLevelFindingsLine state={findings} />}
            />

            {pageError ? (
              // A later page failing never clears the pages already read.
              <div className="mt-3 flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">
                  Could not load more runs. {pageError.message}
                </span>
                <Button size="sm" variant="ghost" onClick={retryFailedPage}>
                  Retry
                </Button>
              </div>
            ) : null}

            {canLoadMore ? (
              <div className="mt-3">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={loadMore}
                  disabled={isLoadingMore}
                  data-testid="stage-analytics-load-more"
                >
                  {isLoadingMore ? "Loading…" : "Load more runs"}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
