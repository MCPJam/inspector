import type { ReactNode } from "react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@mcpjam/design-system/table";

interface ComparisonTableProps {
  headers: string[];
  rows: { cells: (string | ReactNode)[] }[];
}

export function ComparisonTable({ headers, rows }: ComparisonTableProps) {
  return (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      <Table className="text-[13px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {headers.map((header, i) => (
              <TableHead
                key={i}
                className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground h-9 px-3"
              >
                {header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i} className="hover:bg-muted/30">
              {row.cells.map((cell, j) => (
                <TableCell
                  key={j}
                  className={`px-3 py-2.5 text-foreground/80 leading-relaxed whitespace-normal ${
                    j === 0 ? "font-medium text-foreground/90" : ""
                  }`}
                >
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
