import { ClientChip } from "@/components/clients/client-chip";
import { cn } from "@/lib/utils";
import {
  runCaseListHeadClassName,
  runCaseTitleClassName,
} from "../run-case-list-shared";
import { HostCell } from "./host-cell";
import type { CrossHostData, HostColumn } from "./use-cross-host-data";

interface CrossHostMatrixProps {
  data: CrossHostData;
  expanded?: boolean;
  onTestCaseClick?: (testCaseId: string) => void;
}

function formatHostFallback(hostId: string): string {
  const tail = hostId.slice(-6);
  return `…${tail}`;
}

function HostColumnHeader({ col }: { col: HostColumn }) {
  const displayName =
    col.hostName ?? formatHostFallback(col.hostId);

  return (
    <div
      className={cn(
        "flex min-w-[10.5rem] flex-col items-center gap-1.5 px-3 py-3",
        col.isHistorical && "opacity-60",
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
}: CrossHostMatrixProps) {
  const { hostColumns, caseRows, matrix } = data;

  return (
    <div
      className={cn(
        "overflow-auto",
        expanded && "h-full min-h-[420px]",
      )}
    >
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className={runCaseListHeadClassName}>
            <th
              className={cn(
                "sticky left-0 z-20 min-w-[14rem] border-b border-r border-border/60 bg-muted/60 text-left",
                runCaseTitleClassName,
                "px-4 py-2.5 font-sans text-base font-semibold normal-case tracking-normal text-foreground sm:text-lg",
              )}
            >
              Case
              <span className="ml-1.5 font-mono text-sm font-normal tabular-nums text-muted-foreground">
                · {caseRows.length}
              </span>
            </th>
            {hostColumns.map((col) => (
              <th
                key={col.hostId}
                className="border-b border-r border-border/60 bg-muted/60 text-center align-bottom"
              >
                <HostColumnHeader col={col} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {caseRows.map((row) => {
            const byHost = matrix.get(row.caseId);
            const openCase = () => onTestCaseClick?.(row.caseId);
            return (
              <tr
                key={row.caseId}
                data-testid={`test-case-row-${row.caseId}`}
                className={cn(
                  "transition-colors",
                  onTestCaseClick &&
                    "cursor-pointer hover:bg-muted/50 focus-within:bg-muted/50",
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
                <td className="sticky left-0 z-10 border-r border-border/40 bg-inherit px-4 py-2.5 backdrop-blur-sm">
                  <span
                    className={cn(runCaseTitleClassName, "block")}
                    title={row.caseTitle}
                  >
                    {row.caseTitle}
                  </span>
                </td>
                {hostColumns.map((col) => (
                  <td
                    key={col.hostId}
                    className="border-r border-border/40 align-top bg-background/50"
                  >
                    <HostCell data={byHost?.get(col.hostId)} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
