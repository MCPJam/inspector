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
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

import {
  USER_VALUE_STAGES,
  USER_VALUE_STAGE_LABELS,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import { formatRunCaseLatencyMs } from "../evals/run-case-groups";
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
  stillFailing: "bg-amber-500/15 text-amber-600 dark:text-amber-500",
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
  inconclusive: "bg-amber-500/15 text-amber-600 dark:text-amber-500",
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
  // No verdict was read for this case. A dash is not a state word, so it
  // cannot be mistaken for one.
  return (
    <span
      className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-dashed border-border text-[11px] text-muted-foreground"
      aria-label="No verdict read for this case"
    >
      –
    </span>
  );
}

const CELL_CLASS: Record<CaseRowIterationCell["outcome"], string> = {
  passed: "border-success/70 bg-success/25",
  failed: "border-destructive bg-destructive",
  cancelled: "border-border bg-muted",
  pending: "border-border bg-transparent",
};

function IterationStrip({ row }: { row: EvaluateCaseRow }) {
  // One cell per iteration, so the strip's LENGTH is the sample size. A case
  // run once and a case run ten times should not look alike.
  if (row.cells.length <= 1) return null;
  return (
    <div
      className="mt-1.5 flex flex-wrap gap-[3px]"
      aria-label={`${row.iterations.passed} of ${row.iterations.total} iterations passed`}
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
        title={`${label}: passed in ${state.count} ${
          state.count === 1 ? "iteration" : "iterations"
        }`}
      />
    );
  }

  if (state.kind === "partial") {
    // Split, not rounded. Some iterations passed here and the rest never
    // arrived; either solid colour would be false about most of them.
    const total = state.passed + state.unreached;
    return (
      <span
        className="inline-flex h-2 w-3.5 overflow-hidden rounded-[2px]"
        title={`${label}: passed in ${state.passed} of ${total}, ${state.unreached} never reached it`}
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
      return "counted in iterations — this run has no per-case verdict";
    case "noMatch":
      return "no verdict row matched this case";
    case "identityNotEncodable":
      return "this case's identity could not be matched to a verdict row";
    case "notLoaded":
      return null;
    case "matched":
      return row.mark === null && row.verdict.variants.length > 1
        ? "variants disagree — open the case for each one"
        : null;
  }
}

export function RunCaseRows({
  rows,
  defaultOpenKey,
  pills,
  onOpenIteration,
  renderBody,
}: {
  rows: readonly EvaluateCaseRow[];
  defaultOpenKey: string | null;
  /** Per-row change pills. A row with no entry gets none, never "Unchanged". */
  pills?: ReadonlyMap<string, RunChangePill>;
  onOpenIteration?: (target: {
    testCaseId: string;
    iterationId: string;
  }) => void;
  /** The expanded body, supplied by the container. */
  renderBody?: (row: EvaluateCaseRow) => React.ReactNode;
}) {
  const [openKey, setOpenKey] = useState<string | null>(defaultOpenKey);

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
              <span className="pt-0.5">
                <Mark row={row} />
              </span>
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
              <ChevronRight
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-90",
                )}
              />
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
                    Open this iteration
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
