import { ClientChip } from "@/components/clients/client-chip";
import { cn } from "@/lib/utils";
import {
  runCaseListHeadClassName,
  runCaseTitleClassName,
} from "../run-case-list-shared";
import {
  evalSurfaceCellClass,
  evalSurfaceHeaderClass,
  evalSurfaceRowHoverClass,
} from "../eval-surface-chrome";
import { HostCell } from "./host-cell";
import type { CellData, CrossHostData, HostColumn } from "./use-cross-host-data";
import {
  buildBaseMetricComparisons,
  formatHostFallback,
  projectComparisonsForHost,
} from "./metric-comparison";

interface CrossHostMatrixProps {
  data: CrossHostData;
  expanded?: boolean;
  onTestCaseClick?: (testCaseId: string) => void;
  /**
   * Click a per-(case,host) cell. The cell carries the iterations that
   * produced its aggregate; consumers route to that iteration's trace
   * (typically the run-detail view filtered to that case).
   */
  onCellOpen?: (cell: CellData, hostId: string, caseId: string) => void;
}

function HostColumnHeader({ col }: { col: HostColumn }) {
  const displayName = col.hostName ?? formatHostFallback(col.hostId);

  return (
    <div
      className={cn(
        "flex min-w-[10.5rem] flex-col items-center gap-1.5 px-3 py-3",
        col.isHistorical && "opacity-60"
      )}
    >
      <ClientChip
        name={displayName}
        hostId={col.hostId}
        className="max-w-[11rem] border-border/70 bg-background/80 px-2 py-0.5 text-[10px] shadow-none"
      />
      {col.isHistorical ? (
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
          historical
        </span>
      ) : null}
    </div>
  );
}

export function CrossHostMatrix({
  data,
  expanded = false,
  onTestCaseClick,
  onCellOpen,
}: CrossHostMatrixProps) {
  const { hostColumns, caseRows, matrix } = data;

  return (
    <div className={cn("overflow-auto", expanded && "h-full min-h-[420px]")}>
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className={runCaseListHeadClassName}>
            <th
              className={cn(
                "sticky left-0 z-20 min-w-[14rem] border-b border-r border-border/60 px-4 py-2 text-left",
                evalSurfaceHeaderClass,
              )}
            >
              Case
              <span className="ml-1.5 font-mono tabular-nums text-muted-foreground/80">
                {caseRows.length}
              </span>
            </th>
            {hostColumns.map((col) => (
              <th
                key={col.hostId}
                className={cn(
                  "border-b border-r border-border/60 text-center align-bottom",
                  evalSurfaceHeaderClass
                )}
              >
                <HostColumnHeader col={col} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {caseRows.map((row) => {
            const byHost = matrix.get(row.caseId);
            const baseComparisons = buildBaseMetricComparisons(
              hostColumns,
              byHost,
            );
            const openCase = () => onTestCaseClick?.(row.caseId);
            return (
              <tr
                key={row.caseId}
                data-testid={`test-case-row-${row.caseId}`}
              >
                <td
                  className={cn(
                    "sticky left-0 z-10 border-r border-border/40 bg-inherit px-4 py-2.5 backdrop-blur-sm",
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
                  <span
                    className={cn(
                      runCaseTitleClassName,
                      "block",
                      onTestCaseClick &&
                        "underline decoration-dotted underline-offset-4 decoration-muted-foreground/40",
                    )}
                    title={row.caseTitle}
                  >
                    {row.caseTitle}
                  </span>
                </td>
                {hostColumns.map((col) => {
                  const cell = byHost?.get(col.hostId);
                  const cellInteractive = !!(
                    onCellOpen &&
                    cell &&
                    cell.totalCount > 0
                  );
                  const openCell = () => {
                    if (cell) onCellOpen?.(cell, col.hostId, row.caseId);
                  };
                  return (
                    <td
                      key={col.hostId}
                      className={cn(
                        "border-r border-border/50 align-top",
                        evalSurfaceCellClass,
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
                        metricComparisons={projectComparisonsForHost(
                          baseComparisons,
                          col.hostId,
                        )}
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
