import type { ReactNode } from "react";
import { motion } from "framer-motion";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { sectionChild } from "./article-primitives";

interface ComparisonTableProps {
  headers: string[];
  rows: { cells: (string | ReactNode)[] }[];
  order?: number;
}

export function ComparisonTable({
  headers,
  rows,
  order = 3,
}: ComparisonTableProps) {
  return (
    <motion.div
      className="rounded-lg border border-border/50 overflow-hidden"
      {...sectionChild(order)}
    >
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
    </motion.div>
  );
}
