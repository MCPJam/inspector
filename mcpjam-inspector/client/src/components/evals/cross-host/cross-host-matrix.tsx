import { cn } from "@/lib/utils";
import { HostCell } from "./host-cell";
import type { CrossHostData, HostColumn } from "./use-cross-host-data";

interface CrossHostMatrixProps {
  data: CrossHostData;
}

/**
 * Render a host's display name when present, otherwise fall back to a
 * monospaced short suffix of the hostId. Slicing the prefix produced
 * truncated slugs like `claude_d`; the last 6 chars of an opaque ID
 * read more honestly as "this is an id we don't have a name for" while
 * still being distinct enough between hosts in the column header.
 */
function formatHostFallback(hostId: string): string {
  const tail = hostId.slice(-6);
  return `…${tail}`;
}

function HostHeader({ col }: { col: HostColumn }) {
  const hasName = col.hostName !== null && col.hostName !== undefined;
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-0.5 px-2 py-1 text-center",
        col.isHistorical && "opacity-60",
      )}
    >
      <span
        className={cn(
          "truncate text-xs font-medium max-w-[120px]",
          !hasName && "font-mono text-muted-foreground",
        )}
        title={col.hostName ?? col.hostId}
      >
        {hasName ? col.hostName : formatHostFallback(col.hostId)}
      </span>
      {col.isHistorical && (
        <span className="text-[9px] text-muted-foreground uppercase tracking-wide">
          historical
        </span>
      )}
    </div>
  );
}

export function CrossHostMatrix({ data }: CrossHostMatrixProps) {
  const { hostColumns, caseRows, matrix } = data;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {/* Case column header */}
            <th className="sticky left-0 z-10 bg-card border-b border-r px-3 py-2 text-left text-xs font-medium text-muted-foreground min-w-[180px]">
              Case
            </th>
            {hostColumns.map((col) => (
              <th
                key={col.hostId}
                className="border-b border-r px-2 py-1 text-xs font-medium text-muted-foreground min-w-[140px]"
              >
                <HostHeader col={col} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {caseRows.map((row, rowIdx) => {
            const byHost = matrix.get(row.caseId);
            return (
              <tr
                key={row.caseId}
                className={cn(
                  "hover:bg-muted/30 transition-colors",
                  rowIdx % 2 === 0 ? "bg-card" : "bg-muted/10",
                )}
              >
                <td className="sticky left-0 z-10 border-b border-r px-3 py-2 bg-inherit">
                  <span
                    className="truncate text-xs font-medium max-w-[220px] block"
                    title={row.caseTitle}
                  >
                    {row.caseTitle}
                  </span>
                </td>
                {hostColumns.map((col) => (
                  <td
                    key={col.hostId}
                    className="border-b border-r align-top"
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
