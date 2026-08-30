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
import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import type { EvalStageAnalyticsV1 } from "@mcpjam/sdk/contract";
import {
  evalSurfaceCardClass,
  evalSurfaceHeaderClass,
} from "../evals/eval-surface-chrome";
import { useEvalSuiteStageAnalytics } from "@/hooks/use-eval-suite-stage-analytics";
import {
  NOT_MEASURED_LABEL,
  deriveStageAnalyticsPanelState,
  overallSlice,
  slicesOfDimension,
  toRunHeaderView,
  toSetupView,
  toSliceView,
  type SliceView,
  type StageRateView,
  type StageRowView,
} from "./stage-analytics-model";

function formatCompletedAt(epochMs: number | null): string {
  if (epochMs === null) return "no completion stamp";
  return new Date(epochMs).toLocaleString();
}

/** One rate, with its arithmetic and its exclusions. Words when unmeasured. */
function RateCell({ rate }: { rate: StageRateView }) {
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
        <p className="mt-1 text-[10px] text-muted-foreground/80">
          {stage.reasons
            .map((entry) => `${entry.reason} (${entry.count})`)
            .join(", ")}
        </p>
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
        <p className="mt-1 text-[10px] text-muted-foreground/80">
          {slice.failureCategories
            .map((entry) => `${entry.category} (${entry.count})`)
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
    <section className="mt-3">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <div className="mt-1.5 grid gap-2">
        {slices.map((slice) => (
          <SliceBlock key={slice.key} slice={slice} />
        ))}
      </div>
    </section>
  );
}

function RunDocument({ row }: { row: EvalStageAnalyticsV1 }) {
  const header = toRunHeaderView(row);
  const overall = overallSlice(row);
  const intents = slicesOfDimension(row, "intent");
  const models = slicesOfDimension(row, "model");
  const hosts = slicesOfDimension(row, "host");
  const setup = row.setup.map(toSetupView);

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

      {overall ? (
        <section className="mt-3">
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Overall — where the chain stopped
          </h4>
          <div className="mt-1.5">
            <SliceBlock slice={toSliceView(overall, 0)} />
          </div>
        </section>
      ) : null}

      <SliceGroup title="By intent" slices={intents} />
      <SliceGroup title="By model" slices={models} />
      <SliceGroup title="By host" slices={hosts} />

      {setup.length > 0 ? (
        <section className="mt-3" data-testid="stage-analytics-setup">
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Setup
          </h4>
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
        </section>
      ) : null}
    </div>
  );
}

export function StageAnalyticsPanel({
  projectId,
  suiteId,
  runCount,
  runsLoading,
}: {
  projectId: string | null | undefined;
  suiteId: string | null | undefined;
  /** How many runs this suite has — the legacy/empty distinction. */
  runCount: number;
  runsLoading: boolean;
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

            <RunDocument row={selected} />

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
