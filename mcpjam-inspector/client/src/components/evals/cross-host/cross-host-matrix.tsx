import { useMemo } from "react";
import { Trash2 } from "lucide-react";
import { HostChip } from "@/components/hosts/host-chip";
import { cn } from "@/lib/utils";
import { usePersistedState } from "../use-persisted-state";
import {
  CASE_ROW_SORT_STORAGE_KEY,
  CaseRowSortControl,
} from "./case-row-sort-control";
import {
  runCaseListHeadClassName,
  runCaseTitleClassName,
} from "../run-case-list-shared";
import {
  evalSurfaceCellClass,
  evalSurfaceHeaderClass,
  evalSurfaceRowHoverClass,
} from "../eval-surface-chrome";
import {
  aggregateCaseRowMetrics,
  cellsForCaseRow,
  formatCaseRowSummary,
  sortCaseRows,
  type CaseRowSort,
} from "./case-row-metrics";
import { HostCell } from "./host-cell";
import {
  judgeDisagreesWithVerdict,
  resolveCellJudge,
  resolveCellWorkflow,
  type JudgeCase,
  type WorkflowInsight,
} from "../goal-completion-presentation";
import {
  cellOutcome,
  formatHostFallback,
  type CellData,
  type CellOutcome,
  type CrossHostData,
  type HostColumn,
} from "./use-cross-host-data";

/** Settle a cell's deterministic pass/fail for judge-disagreement comparison. */
function cellDeterministicPassed(outcome: CellOutcome): boolean | null {
  if (outcome === "pass") return true;
  if (outcome === "fail" || outcome === "part") return false;
  return null; // running / unsettled
}

interface CrossHostMatrixProps {
  data: CrossHostData;
  expanded?: boolean;
  /** Widen columns for labeled metric strips in All runs view. */
  cellTrends?: boolean;
  /** When set, parent owns sort state (e.g. SuiteResultsSplit pane header). */
  caseRowSort?: CaseRowSort;
  onCaseRowSortChange?: (sort: CaseRowSort) => void;
  /** Hide the in-table sort trigger when the parent renders CaseRowSortControl. */
  sortControlInHeader?: boolean;
  onTestCaseClick?: (testCaseId: string) => void;
  /**
   * Click a per-(case,host) cell. The cell carries the iterations that
   * produced its aggregate; consumers route to that iteration's trace
   * (typically the run-detail view filtered to that case).
   */
  onCellOpen?: (cell: CellData, hostId: string, caseId: string) => void;
  /** Delete a test case (renders a trash control on each case row). */
  onDeleteCase?: (caseId: string, caseTitle: string) => void;
  /**
   * Drop "historical" columns (hosts that ran before but are no longer
   * attached). On the suite landing we compare the suite's CURRENT clients;
   * a stale host with only a truncated id is noise there. The full "by host"
   * tab leaves them visible.
   */
  hideHistorical?: boolean;
  /**
   * Per-host verdicts from the cross-host group judge, keyed by namedHostId
   * (== HostColumn.hostId). Renders a small verdict label under each host
   * header. Only supplied in the group view.
   */
  hostVerdicts?: HostVerdictMap;
  /**
   * Advisory LLM-as-judge verdicts, indexed `runId → caseKey → verdict`. Each
   * (case, host) cell resolves its verdict from its own run, so a small badge
   * surfaces next to the deterministic pass/fail. Omitted → no badges.
   */
  judgeByRunAndCaseKey?: Map<string, Map<string, JudgeCase>> | null;
  /** Server-quality workflow findings per (case×host); shown in the cell expansion. */
  workflowByRunAndCaseKey?: Map<string, Map<string, WorkflowInsight>> | null;
}

/** Pinned case label column — matches host-config comparison matrix (~300px). */
const CASE_COLUMN_WIDTH_PX = 300;
const HOST_COLUMN_WIDTH_PX = {
  trends: 336,
  snapshot: 216,
} as const;

const stickyCaseColumnClass =
  "sticky left-0 border-r border-border/40 bg-background backdrop-blur-sm";

/** Per-host verdict from the cross-host group judge, keyed by namedHostId. */
export type HostVerdict = {
  verdict: "incomplete" | "weak" | "mixed" | "strong";
  summary: string;
};
export type HostVerdictMap = Map<string, HostVerdict>;

const HOST_VERDICT_TONE: Record<HostVerdict["verdict"], string> = {
  strong: "text-success",
  mixed: "text-amber-600 dark:text-amber-400",
  weak: "text-destructive",
  incomplete: "text-muted-foreground",
};

function HostColumnHeader({
  col,
  verdict,
}: {
  col: HostColumn;
  verdict?: HostVerdict;
}) {
  const displayName = col.hostName ?? formatHostFallback(col.hostId);

  return (
    <div
      className={cn(
        "flex w-full flex-col items-center gap-1.5 px-3 py-3",
        col.isHistorical && "opacity-60",
      )}
    >
      <HostChip
        name={displayName}
        hostId={col.hostId}
        layout="stack"
        size="sm"
      />
      {col.isHistorical ? (
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
          historical
        </span>
      ) : null}
      {/* Cross-host verdict (group view only). "incomplete" is judge noise — hide it. */}
      {verdict && verdict.verdict !== "incomplete" ? (
        <span
          className={cn(
            "font-mono text-[9px] uppercase tracking-[0.14em]",
            HOST_VERDICT_TONE[verdict.verdict],
          )}
          title={verdict.summary || undefined}
        >
          {verdict.verdict}
        </span>
      ) : null}
    </div>
  );
}

export function CrossHostMatrix({
  data,
  expanded = false,
  cellTrends = false,
  caseRowSort: caseRowSortProp,
  onCaseRowSortChange,
  sortControlInHeader = false,
  onTestCaseClick,
  onCellOpen,
  onDeleteCase,
  hideHistorical = false,
  hostVerdicts,
  judgeByRunAndCaseKey,
  workflowByRunAndCaseKey,
}: CrossHostMatrixProps) {
  const { caseRows, matrix } = data;
  const hostColumns = hideHistorical
    ? data.hostColumns.filter((col) => !col.isHistorical)
    : data.hostColumns;

  const [internalCaseRowSort, setInternalCaseRowSort] =
    usePersistedState<CaseRowSort>(CASE_ROW_SORT_STORAGE_KEY, "suite-order");
  const caseRowSort = caseRowSortProp ?? internalCaseRowSort;
  const setCaseRowSort = onCaseRowSortChange ?? setInternalCaseRowSort;

  const sortedCaseRows = useMemo(
    () => sortCaseRows(caseRows, matrix, hostColumns, caseRowSort),
    [caseRows, matrix, hostColumns, caseRowSort],
  );

  const hostMinColumnWidthPx = cellTrends
    ? HOST_COLUMN_WIDTH_PX.trends
    : HOST_COLUMN_WIDTH_PX.snapshot;
  const tableMinWidthPx =
    CASE_COLUMN_WIDTH_PX + hostColumns.length * hostMinColumnWidthPx;

  return (
    <div
      className={cn(
        "w-full overflow-auto",
        expanded && "h-full min-h-[420px]",
      )}
    >
      <table
        className="w-full table-fixed border-collapse text-sm"
        style={{ minWidth: tableMinWidthPx }}
      >
        <colgroup>
          <col style={{ width: CASE_COLUMN_WIDTH_PX }} />
          {hostColumns.map((col) => (
            <col key={col.hostId} />
          ))}
        </colgroup>
        <thead>
          <tr className={runCaseListHeadClassName}>
            <th
              className={cn(
                "sticky left-0 z-20 w-[300px] max-w-[300px] border-b border-r border-border/60 px-4 py-2 text-left align-bottom",
                stickyCaseColumnClass,
                evalSurfaceHeaderClass,
              )}
            >
              <div className="flex items-center gap-2">
                {!sortControlInHeader ? (
                  <CaseRowSortControl
                    value={caseRowSort}
                    onChange={setCaseRowSort}
                  />
                ) : null}
                <span>
                  Case
                  <span className="ml-1.5 font-mono tabular-nums text-muted-foreground/80">
                    {caseRows.length}
                  </span>
                </span>
              </div>
            </th>
            {hostColumns.map((col) => (
              <th
                key={col.hostId}
                className={cn(
                  "border-b border-r border-border/60 text-center align-bottom",
                  evalSurfaceHeaderClass,
                )}
              >
                <HostColumnHeader
                  col={col}
                  verdict={hostVerdicts?.get(col.hostId)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {sortedCaseRows.map((row) => {
            const byHost = matrix.get(row.caseId);
            const rowCells = cellsForCaseRow(row.caseId, matrix, hostColumns);
            const rowSummary = formatCaseRowSummary(
              aggregateCaseRowMetrics(rowCells),
            );
            // Cross-client divergence: when ≥2 clients ran this case, flag rows
            // where they DISAGREE (amber — a per-client behavior difference) or
            // ALL fail (red — likely a real server bug). All-pass stays calm.
            // Only settled cells (pass/fail/partial) inform divergence; cells
            // still running mid-"Run all" carry no verdict yet, so excluding
            // them keeps the row from flashing red before any iteration lands.
            const settledOutcomes = hostColumns
              .map((col) => byHost?.get(col.hostId))
              .filter(
                (c): c is NonNullable<typeof c> => !!c && c.totalCount > 0,
              )
              .map(cellOutcome)
              .filter((o) => o !== "running");
            const passFlags = settledOutcomes.map((o) => o === "pass");
            const rowTone: "diverge" | "allfail" | null =
              settledOutcomes.length >= 2
                ? passFlags.every(Boolean)
                  ? null
                  : passFlags.some(Boolean)
                    ? "diverge"
                    : "allfail"
                : null;
            const openCase = () => onTestCaseClick?.(row.caseId);
            const showRowSummary = rowSummary && !cellTrends;

            return (
              <tr
                key={row.caseId}
                data-testid={`test-case-row-${row.caseId}`}
                data-divergence={rowTone ?? undefined}
                className={cn(
                  "group",
                  rowTone === "diverge" && "bg-amber-500/[0.05]",
                )}
              >
                <td
                  className={cn(
                    "z-10 w-[300px] max-w-[300px] align-top px-4 py-2.5",
                    stickyCaseColumnClass,
                    rowTone === "diverge" && "border-l-2 border-l-amber-500",
                    rowTone === "allfail" &&
                      "border-l-2 border-l-destructive",
                    onTestCaseClick && "cursor-pointer hover:bg-muted/40",
                  )}
                  tabIndex={onTestCaseClick ? 0 : undefined}
                  role={onTestCaseClick ? "button" : undefined}
                  aria-label={
                    onTestCaseClick
                      ? `Open test case: ${row.caseTitle}`
                      : undefined
                  }
                  onClick={onTestCaseClick ? openCase : undefined}
                  onKeyDown={
                    onTestCaseClick
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            openCase();
                          }
                        }
                      : undefined
                  }
                >
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-start gap-2">
                      <span
                        className={cn(
                          runCaseTitleClassName,
                          "line-clamp-2 min-w-0 flex-1 leading-snug",
                          onTestCaseClick &&
                            "underline decoration-dotted underline-offset-4 decoration-muted-foreground/40",
                        )}
                        title={row.caseTitle}
                      >
                        {row.caseTitle}
                      </span>
                      {onDeleteCase ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onDeleteCase(row.caseId, row.caseTitle);
                          }}
                          title="Delete test case"
                          aria-label={`Delete test case: ${row.caseTitle}`}
                          className="shrink-0 rounded p-1 text-muted-foreground/50 opacity-0 transition-[opacity,colors] group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                    {showRowSummary ? (
                      <p
                        className="truncate text-[10.5px] tabular-nums text-muted-foreground"
                        data-testid={`case-row-summary-${row.caseId}`}
                        title={rowSummary}
                      >
                        {rowSummary}
                      </p>
                    ) : null}
                  </div>
                </td>
                {hostColumns.map((col) => {
                  const cell = byHost?.get(col.hostId);
                  const cellInteractive = !!(
                    onCellOpen &&
                    cell &&
                    cell.totalCount > 0
                  );
                  // Advisory judge verdict for this (case, host) cell, resolved
                  // from the cell's own run. Disagreement (judge vs the cell's
                  // deterministic pass/fail) is the high-signal moment.
                  const judgeCase =
                    cell && cell.totalCount > 0
                      ? resolveCellJudge(cell.iterations, judgeByRunAndCaseKey)
                      : undefined;
                  const judgeDisagrees = judgeCase
                    ? judgeDisagreesWithVerdict(
                        cellDeterministicPassed(cellOutcome(cell!)),
                        judgeCase.passed,
                      )
                    : false;
                  const workflowInsight =
                    cell && cell.totalCount > 0
                      ? resolveCellWorkflow(
                          cell.iterations,
                          workflowByRunAndCaseKey,
                        )
                      : undefined;
                  const openCell = () => {
                    if (cell) onCellOpen?.(cell, col.hostId, row.caseId);
                  };
                  return (
                    <td
                      key={col.hostId}
                      className={cn(
                        "border-r border-border/50 align-top",
                        evalSurfaceCellClass,
                        cellTrends && "overflow-visible",
                        cellInteractive &&
                          cn("cursor-pointer", evalSurfaceRowHoverClass),
                      )}
                      tabIndex={cellInteractive ? 0 : undefined}
                      role={cellInteractive ? "button" : undefined}
                      aria-label={
                        cellInteractive
                          ? `Open ${col.hostName ?? col.hostId} iteration for ${row.caseTitle}`
                          : undefined
                      }
                      onClick={cellInteractive ? openCell : undefined}
                      onKeyDown={
                        cellInteractive
                          ? (event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                openCell();
                              }
                            }
                          : undefined
                      }
                    >
                      <HostCell
                        data={cell}
                        trendsLayout={cellTrends}
                        judgeCase={judgeCase}
                        judgeDisagrees={judgeDisagrees}
                        workflowInsight={workflowInsight}
                        onOpenTrace={cellInteractive ? openCell : undefined}
                      />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
