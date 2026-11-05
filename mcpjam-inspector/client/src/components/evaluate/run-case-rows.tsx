/**
 * The cases, as rows a reader can scan.
 *
 * Three things the old list could not show, in the three columns that matter:
 * where each case's chain stopped, how many of its iterations passed, and what
 * the six-stage chain looked like across them. Failures sort to the top, and
 * the first failing row opens on load.
 *
 * The colour rule is the whole honesty of this component: a MARK is painted
 * only when a verdict was read for that case. A row whose verdict could not be
 * joined shows its iteration fraction in plain type and says why, because
 * "2 of 3 iterations passed" is a population and "this case passed" is a
 * decision against a threshold nobody here has seen.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronRight, Pencil, Search } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { cn } from "@/lib/utils";
import {
  EvalListFilter,
  ALL_EVAL_FILTER_VALUES,
} from "../evals/eval-list-filter";
import { runHistoryFilterClass } from "../evals/run-history-table";
import {
  cellResult,
  resultCounts,
  type RunResultsMatrixData,
} from "./run-results-matrix-model";

import {
  USER_VALUE_STAGES,
  USER_VALUE_STAGE_LABELS,
  measurementUnitLabel,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import { formatRunCaseLatencyMs } from "../evals/run-case-groups";
import { formatCostOrDash } from "../evals/helpers";
import {
  caseRowReasonLabel,
  type CaseRowIterationCell,
  type EvaluateCaseRow,
  type StageCellState,
} from "./evaluate-case-row-model";
import type { RunChangePill } from "./evaluate-run-diff-model";

const PILL_CLASS: Record<RunChangePill["kind"], string> = {
  regressed: "bg-destructive/15 text-destructive",
  fixed: "bg-success/15 text-success",
  stillFailing: "bg-warning/15 text-warning",
  unchanged: "bg-muted text-muted-foreground",
  added: "bg-muted text-muted-foreground",
  reconfigured: "bg-muted text-muted-foreground",
};

function ChangePill({ pill }: { pill: RunChangePill }) {
  return (
    <span className="hidden w-32 shrink-0 flex-col items-start gap-0.5 sm:flex">
      <span
        className={cn(
          "rounded-full px-2 py-0.5 text-[11px] font-medium",
          PILL_CLASS[pill.kind],
        )}
      >
        {pill.label}
      </span>
      {pill.detail ? (
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {pill.detail}
        </span>
      ) : null}
    </span>
  );
}

const MARK_CLASS: Record<"passed" | "failed" | "inconclusive", string> = {
  passed: "bg-success/15 text-success",
  failed: "bg-destructive text-destructive-foreground",
  inconclusive: "bg-warning/15 text-warning",
};

const MARK_GLYPH: Record<"passed" | "failed" | "inconclusive", string> = {
  passed: "✓",
  failed: "✕",
  inconclusive: "?",
};

function Mark({ row }: { row: EvaluateCaseRow }) {
  if (row.mark) {
    return (
      <span
        className={cn(
          "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
          MARK_CLASS[row.mark],
        )}
        aria-label={`Case verdict: ${row.mark}`}
      >
        {MARK_GLYPH[row.mark]}
      </span>
    );
  }
  return null;
}

const CELL_CLASS: Record<CaseRowIterationCell["outcome"], string> = {
  passed: "border-success/70 bg-success/25",
  failed: "border-destructive bg-destructive",
  cancelled: "border-border bg-muted",
  pending: "border-border bg-transparent",
};

function IterationStrip({ row }: { row: EvaluateCaseRow }) {
  // One cell per trial, so the strip's LENGTH is the sample size. A case run
  // once and a case run ten times should not look alike.
  if (row.cells.length <= 1) return null;
  return (
    <div
      className="mt-1.5 flex flex-wrap gap-[3px]"
      aria-label={`${row.iterations.passed} of ${row.iterations.total} ${measurementUnitLabel(
        "trial",
        row.iterations.total,
      )} passed`}
    >
      {row.cells.map((cell) => (
        <span
          key={cell.iterationId}
          title={
            cell.stage
              ? `Broke at ${USER_VALUE_STAGE_LABELS[cell.stage]}`
              : cell.outcome
          }
          className={cn(
            "h-2.5 w-2.5 rounded-[2px] border",
            CELL_CLASS[cell.outcome],
          )}
        />
      ))}
    </div>
  );
}

/**
 * One square per stage, saying what happened there across the loaded chains.
 *
 * The rule this enforces is the row's whole reason for existing: a stage is
 * green only when every chain we hold reported it PASSED. A case that stopped
 * at Selection never reached Call, and painting Call green because nothing
 * broke there would be a claim about three stages the run never measured.
 */
function StageCell({
  stage,
  state,
}: {
  stage: UserValueStage;
  state: StageCellState;
}) {
  const label = USER_VALUE_STAGE_LABELS[stage];

  if (state.kind === "failed") {
    return (
      <span
        className="inline-flex h-3 min-w-[14px] items-center justify-center rounded-[2px] bg-destructive px-[3px] text-[9px] font-bold tabular-nums text-destructive-foreground"
        title={`${label}: ${state.count} broke here`}
      >
        {state.count}
      </span>
    );
  }

  if (state.kind === "passed") {
    return (
      <span
        className="inline-block h-2 w-3.5 rounded-[2px] bg-success/70"
        title={`${label}: passed in ${state.count} ${measurementUnitLabel(
          "trial",
          state.count,
        )}`}
      />
    );
  }

  if (state.kind === "partial") {
    // Split, not rounded. Some iterations passed here and the rest did not
    // arrive, were not decided, or did not apply — three different facts, so
    // the title names whichever actually occurred instead of one lumped count.
    const total =
      state.passed + state.notReached + state.notMeasured + state.notApplicable;
    const rest = [
      state.notReached > 0 ? `${state.notReached} never reached it` : null,
      state.notMeasured > 0 ? `${state.notMeasured} not measured` : null,
      state.notApplicable > 0 ? `${state.notApplicable} not applicable` : null,
    ].filter((part): part is string => part !== null);
    return (
      <span
        className="inline-flex h-2 w-3.5 overflow-hidden rounded-[2px]"
        title={`${label}: passed in ${state.passed} of ${total}, ${rest.join(
          ", ",
        )}`}
      >
        <span
          className="h-full bg-success/70"
          style={{ width: `${Math.round((state.passed / total) * 100)}%` }}
        />
        <span className="h-full flex-1 bg-muted-foreground/30" />
      </span>
    );
  }

  if (state.kind === "notReached") {
    return (
      <span
        className="inline-block h-2 w-3.5 rounded-[2px] bg-muted-foreground/30"
        title={`${label}: never reached`}
      />
    );
  }

  return (
    <span
      className="inline-block h-2 w-3.5 rounded-[2px] border border-dashed border-border"
      title={`${label}: ${
        state.kind === "notLoaded"
          ? "chain not loaded"
          : state.kind === "notApplicable"
          ? "does not apply to this case"
          : "not measured"
      }`}
    />
  );
}

function ChainCells({ row }: { row: EvaluateCaseRow }) {
  return (
    <span className="hidden items-center gap-1 sm:inline-flex">
      {USER_VALUE_STAGES.map((stage) => (
        <StageCell
          key={stage}
          stage={stage}
          state={row.coverage.stageStates[stage]}
        />
      ))}
    </span>
  );
}

function breakText(row: EvaluateCaseRow): string {
  const reason = caseRowReasonLabel(row);
  switch (row.break.kind) {
    case "brokeAt":
      return `Broke at ${USER_VALUE_STAGE_LABELS[row.break.stage]}${
        reason ? `: ${reason}` : ""
      }`;
    case "noFailedStage":
      return reason
        ? `Did not complete: ${reason}`
        : "Did not complete, and no stage was established";
    case "withheld":
      return "Stage chain did not validate, so where it broke is not established";
    case "notLoaded":
      return "Chain not loaded for this case";
    case "none":
      return row.iterations.passed === row.iterations.total
        ? "All measured stages passed"
        : "No stage failure was established";
  }
}

function verdictNote(row: EvaluateCaseRow): string | null {
  switch (row.verdict.kind) {
    case "legacyRun":
      return `counted in ${measurementUnitLabel(
        "trial",
        0,
      )} — this run has no per-case verdict`;
    case "noMatch":
      return "no verdict row matched this case";
    case "identityNotEncodable":
      return "this case's identity could not be matched to a verdict row";
    case "notLoaded":
      return null;
    case "matched":
      return row.mark === null && row.verdict.variants.length > 1
        ? "variants disagree. Open the case for each one"
        : null;
  }
}

export function RunCaseRows({
  rows,
  defaultOpenKey,
  pills,
  routeLines,
  onOpenIteration,
  renderBody,
}: {
  rows: readonly EvaluateCaseRow[];
  defaultOpenKey: string | null;
  /** Per-row change pills. A row with no entry gets none, never "Unchanged". */
  pills?: ReadonlyMap<string, RunChangePill>;
  /** Per-row route one-liners, keyed by `row.key`. Same pattern as `pills`. */
  routeLines?: ReadonlyMap<string, string>;
  onOpenIteration?: (target: {
    testCaseId: string;
    iterationId: string;
  }) => void;
  /** The expanded body, supplied by the container. */
  renderBody?: (row: EvaluateCaseRow) => React.ReactNode;
}) {
  const [openKey, setOpenKey] = useState<string | null>(defaultOpenKey);
  // The rows arrive after the decision read resolves, so the FIRST render has
  // no failing row to nominate and `useState` would keep that initial null
  // forever — the failing case would render closed on every real run. Adopt a
  // later nomination once, and never again, so a reader who closes the row
  // does not have it reopened under them.
  const adoptedDefault = useRef(defaultOpenKey);
  useEffect(() => {
    if (adoptedDefault.current === defaultOpenKey) return;
    adoptedDefault.current = defaultOpenKey;
    setOpenKey(defaultOpenKey);
  }, [defaultOpenKey]);

  if (rows.length === 0) {
    return (
      <p className="px-5 py-6 text-[13px] text-muted-foreground">
        This run has no cases to show.
      </p>
    );
  }

  return (
    <div className="divide-y divide-border/40" data-testid="run-case-rows">
      {rows.map((row) => {
        const open = openKey === row.key;
        const note = verdictNote(row);
        return (
          <div key={row.key} data-testid={`run-case-row-${row.key}`}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpenKey(open ? null : row.key)}
              className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-muted/50"
            >
              <span className="pt-0.5" aria-hidden="true">
                <ChevronRight
                  className={cn(
                    "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                    open && "rotate-90",
                  )}
                />
              </span>
              {row.mark ? (
                <span className="pt-0.5">
                  <Mark row={row} />
                </span>
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[14px] font-semibold text-foreground">
                    {row.title}
                  </span>
                  {row.iterations.total > 1 ? (
                    // Grey, always. The fraction is evidence about a sample;
                    // 1/1 and 10/10 are both "100%" and are not the same
                    // evidence, so it never carries the verdict's colour.
                    <span className="text-[12px] tabular-nums text-muted-foreground">
                      {row.iterations.passed}/{row.iterations.total}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                  {breakText(row)}
                </span>
                {routeLines?.get(row.key) ? (
                  <span
                    className="mt-0.5 block text-[12px] text-muted-foreground"
                    data-testid={`route-line-${row.key}`}
                  >
                    {routeLines.get(row.key)}
                  </span>
                ) : null}
                {note ? (
                  <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                    {note}
                  </span>
                ) : null}
                {row.coverage.note ? (
                  <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                    {row.coverage.note}
                  </span>
                ) : null}
                <IterationStrip row={row} />
              </span>
              <ChainCells row={row} />
              {pills?.get(row.key) ? (
                <ChangePill pill={pills.get(row.key) as RunChangePill} />
              ) : (
                <span className="hidden w-32 shrink-0 sm:block" />
              )}
              <span className="hidden w-16 shrink-0 text-right text-[12.5px] tabular-nums text-muted-foreground sm:block">
                {formatRunCaseLatencyMs(row.p50Ms)}
              </span>
              <span
                // Wider than the latency cell beside it: a cost renders as
                // `$1234.56` or `<$0.0001`, both longer than any duration
                // this column shows, and clipping a money figure is worse
                // than the space it costs to show it.
                className="hidden w-24 shrink-0 truncate text-right text-[12.5px] tabular-nums text-muted-foreground sm:block"
                title={
                  row.costUsd === null
                    ? "No iteration in this case has a cost"
                    : [
                        row.costedIterations < row.coverage.total
                          ? `${row.costedIterations} of ${row.coverage.total} iterations priced`
                          : null,
                        row.hasRunnerReportedCost
                          ? "Includes cost reported by your runner, not measured by MCPJam."
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                }
              >
                {formatCostOrDash(row.costUsd)}
              </span>
            </button>
            {open ? (
              <div
                className="px-5 pb-4 pl-[52px]"
                data-testid="run-case-row-body"
              >
                {renderBody?.(row) ?? null}
                {onOpenIteration && row.testCaseId && row.opensIterationId ? (
                  <button
                    type="button"
                    className="mt-2 text-[12.5px] font-medium text-primary hover:underline"
                    onClick={() =>
                      onOpenIteration({
                        testCaseId: row.testCaseId as string,
                        iterationId: row.opensIterationId as string,
                      })
                    }
                  >
                    Open this {measurementUnitLabel("trial", 1)}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

type TestRunRow = RunResultsMatrixData["rows"][number];
type TestRunTarget = RunResultsMatrixData["targets"][number];
type TestRunOutcome = NonNullable<ReturnType<typeof cellResult>>;

const OUTCOME_WORD: Record<TestRunOutcome, string> = {
  passed: "Pass",
  failed: "Fail",
  pending: "Running",
  cancelled: "Cancelled",
};

const OUTCOME_TONE: Record<TestRunOutcome, string> = {
  passed: "text-success",
  failed: "text-destructive",
  pending: "text-pending",
  cancelled: "text-muted-foreground",
};

const STATUS_FILTER_LABEL: Record<TestRunOutcome, string> = {
  failed: "Failed",
  passed: "Passed",
  pending: "Running",
  cancelled: "Cancelled",
};

/** A column heading: the model, plus the client when the run used several. */
export function testRunTargetLabel(
  target: TestRunTarget,
  targets: readonly TestRunTarget[],
): string {
  const clients = new Set(targets.map((candidate) => candidate.client));
  return clients.size > 1 ? `${target.client} · ${target.model}` : target.model;
}

function TestRunCell({ items }: { items: TestRunTarget["iterations"] }) {
  const result = cellResult(items);
  if (!result) {
    return <span className="text-[12.5px] text-muted-foreground">—</span>;
  }
  const counts = resultCounts(items);
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] tabular-nums">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-current",
          OUTCOME_TONE[result],
        )}
      />
      <span className={cn("font-semibold", OUTCOME_TONE[result])}>
        {OUTCOME_WORD[result]}
      </span>
      <span
        className="text-muted-foreground"
        aria-label={`${counts.passed} of ${items.length} iterations passed`}
      >
        {counts.passed}/{items.length}
      </span>
    </span>
  );
}

/**
 * The Suite run page's Test runs list: one row per case, one column per
 * client and model, each row opening its Test run page.
 *
 * The same rows the expandable list above reads, drawn as links instead of
 * drawers: a test run is a page with its own address now, so the row only
 * says how it went and where to go.
 */
export function RunTestRunRows({
  data,
  onOpen,
  onEdit,
}: {
  data: RunResultsMatrixData;
  onOpen: (row: TestRunRow & { testCaseId: string }) => void;
  /** Absent when the reader cannot edit the suite's cases. */
  onEdit?: (row: TestRunRow & { testCaseId: string }) => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(ALL_EVAL_FILTER_VALUES);
  const query = search.trim().toLowerCase();
  const rowOutcomes = (row: TestRunRow) =>
    data.targets.map((target) => cellResult(target.cells.get(row.key) ?? []));
  const statusOptions = (
    ["failed", "passed", "pending", "cancelled"] as const
  ).filter((value) =>
    data.rows.some((row) => rowOutcomes(row).includes(value)),
  );
  const activeStatus = (statusOptions as readonly string[]).includes(status)
    ? status
    : ALL_EVAL_FILTER_VALUES;
  const rows = data.rows.filter(
    (row) =>
      row.title.toLowerCase().includes(query) &&
      (activeStatus === ALL_EVAL_FILTER_VALUES ||
        rowOutcomes(row).includes(activeStatus as TestRunOutcome)),
  );
  const columns = `minmax(12rem,1fr) repeat(${data.targets.length}, minmax(7.5rem,10rem)) 4.75rem`;

  return (
    <section
      className="space-y-3 px-5 py-5"
      aria-labelledby="run-test-runs-heading"
      data-testid="run-test-runs"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3
          id="run-test-runs-heading"
          className="flex items-baseline gap-2 text-[15px] font-semibold text-foreground"
        >
          Test runs
          <span className="text-[12.5px] font-normal tabular-nums text-muted-foreground">
            {data.rows.length}
          </span>
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-56 max-w-full">
            <Search
              aria-hidden
              className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              className={cn(
                runHistoryFilterClass,
                "w-full max-w-none pl-8 md:text-[11px] dark:bg-card",
              )}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find a test run…"
              aria-label="Find a test run"
            />
          </div>
          <EvalListFilter
            label="Status"
            className="w-32"
            value={activeStatus}
            options={[...statusOptions]}
            formatOption={(value) =>
              STATUS_FILTER_LABEL[value as TestRunOutcome] ?? value
            }
            onChange={setStatus}
          />
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border/60 bg-card">
        <div role="table" aria-label="Test runs" className="min-w-max">
          <div
            role="row"
            className="grid items-center gap-3 border-b border-border/60 bg-muted/40 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            style={{ gridTemplateColumns: columns }}
          >
            <span role="columnheader">Test run</span>
            {data.targets.map((target) => (
              <span
                role="columnheader"
                key={target.key}
                className="truncate normal-case tracking-normal"
              >
                {testRunTargetLabel(target, data.targets)}
              </span>
            ))}
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-[13px] text-muted-foreground">
              {data.rows.length === 0
                ? "This run has no test runs yet."
                : "No test runs match these filters."}
            </p>
          ) : (
            rows.map((row) => {
              const linked = row.testCaseId
                ? { ...row, testCaseId: row.testCaseId }
                : null;
              return (
                <div
                  role="row"
                  key={row.key}
                  data-testid={`run-test-run-row-${row.key}`}
                  className={cn(
                    "grid items-center gap-3 border-b border-border/40 px-4 py-2.5 last:border-b-0",
                    linked && "cursor-pointer hover:bg-muted/50",
                  )}
                  style={{ gridTemplateColumns: columns }}
                  onClick={linked ? () => onOpen(linked) : undefined}
                >
                  <span
                    role="cell"
                    className="truncate text-[14px] text-foreground"
                  >
                    {row.title}
                  </span>
                  {data.targets.map((target) => (
                    <span role="cell" key={target.key}>
                      <TestRunCell items={target.cells.get(row.key) ?? []} />
                    </span>
                  ))}
                  <span
                    role="cell"
                    className="flex justify-end gap-1"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {linked ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="size-7"
                          aria-label={`Open test run: ${row.title}`}
                          title="Open test run"
                          onClick={() => onOpen(linked)}
                        >
                          <ArrowUpRight className="size-3.5" aria-hidden />
                        </Button>
                        {onEdit ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="size-7"
                            aria-label={`Edit test case: ${row.title}`}
                            title="Edit test case"
                            onClick={() => onEdit(linked)}
                          >
                            <Pencil className="size-3.5" aria-hidden />
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
