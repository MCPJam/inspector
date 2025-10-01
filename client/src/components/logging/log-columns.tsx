import { LogLevelBadge } from "./log-level-badge";
import { Badge } from "@/components/ui/badge";
import { ColumnDef, FilterFn, Row } from "@tanstack/react-table";
import { LogEntry } from "@/hooks/use-logger";

export const timestampFilterFn: FilterFn<LogEntry> = (
  row: Row<LogEntry>,
  columnId: string,
  filterValue: any
) => {
  const date = new Date(row.getValue(columnId)).getTime();
  const { from, to } = JSON.parse(filterValue);
  return date >= from && date <= to;
};

export const columns: ColumnDef<LogEntry>[] = [
  {
    accessorKey: "timestamp",
    header: "Timestamp",
    filterFn: timestampFilterFn,
    cell: ({ row }) => {
      return (
        <span className="text-muted-foreground font-mono text-xs flex justify-center">
          {new Date(row.getValue("timestamp")).toLocaleString("en-US", {
            month: "short",
            day: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
      );
    },
  },
  {
    accessorKey: "level",
    header: "Level",
    cell: ({ row }) => {
      return (
        <div className="flex justify-center">
          <LogLevelBadge level={row.getValue("level")} />
        </div>
      );
    },
  },
  {
    accessorKey: "context",
    header: "Context",
    cell: ({ row }) => {
      return (
        <div className="flex justify-center">
          <Badge variant="secondary">{row.getValue("context")}</Badge>
        </div>
      );
    },
  },
  {
    accessorKey: "message",
    header: "Message",
    enableColumnFilter: true,
    cell: ({ row }) => {
      return (
        <span className="flex-1 break-words text-center">
          {row.getValue("message")}
        </span>
      );
    },
  },
];
