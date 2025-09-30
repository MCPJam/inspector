import { ColumnFiltersState, flexRender } from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useRef, useState, useEffect } from "react";
import { columns } from "../components/logging/log-columns";
import LogFilters from "./logging/log-filters";
import { Button } from "./ui/button";
import { useLoggerState } from "@/hooks/use-logger";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import LogDetails from "./logging/log-details";

export const TracingTab = () => {
  const { entries: data } = useLoggerState();

  const topRef = useRef<HTMLDivElement>(null);
  const [topOffset, setTopOffset] = useState(0);

  useEffect(() => {
    if (topRef.current) {
      setTopOffset(topRef.current.getBoundingClientRect().height);
    }

    const handleResize = () => {
      if (topRef.current) {
        setTopOffset(topRef.current.getBoundingClientRect().height);
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const [filters, setFilters] = useState<ColumnFiltersState>([]);

  const onFilterUpdate = (id: string, value: string) => {
    setFilters((prev) =>
      prev
        .filter((f) => f.id !== id)
        .concat({
          id,
          value,
        })
    );
  };

  const table = useReactTable({
    columns,
    data,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    state: {
      columnFilters: filters,
    },
  });

  return (
    <div className="flex flex-col h-full">
      <div
        className="bg-background p-4 space-y-4 flex-shrink-0 sticky top-0 z-10"
        ref={topRef}
      >
        <h2 className="text-lg font-semibold">Tracing</h2>

        <LogFilters filters={filters} onFilterUpdate={onFilterUpdate} />
        <div className="flex flex-row items-center justify-between w-full gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span>Total: {data.length}</span>
            <span>Filtered: {table.getFilteredRowModel().rows.length}</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span>Item(s) per page:</span>
              <Select
                value={String(table.getState().pagination.pageSize)}
                onValueChange={(value) => table.setPageSize(Number(value))}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[10, 20, 30, 40, 50].map((pageSize) => (
                    <SelectItem key={pageSize} value={String(pageSize)}>
                      {pageSize}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                size="icon"
                variant="ghost"
                onClick={() => table.firstPage()}
                disabled={!table.getCanPreviousPage()}
              >
                {"<<"}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                {"<"}
              </Button>
              <span className="flex items-center gap-1">
                {table.getState().pagination.pageIndex + 1} of{" "}
                {table.getPageCount().toLocaleString()}
              </span>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                {">"}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => table.lastPage()}
                disabled={!table.getCanNextPage()}
              >
                {">>"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <table className="m-4 mt-0">
        <thead
          className="sticky z-10 border-b bg-white"
          style={{ top: topOffset }}
        >
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} colSpan={header.colSpan} className="p-2">
                  <div className="flex items-center justify-center">
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext()
                    )}
                  </div>
                </th>
              ))}
            </tr>
          ))}
        </thead>

        {table.getRowModel().rows.length === 0 && (
          <tr>
            <td
              colSpan={table.getAllLeafColumns().length}
              className="p-4 text-center text-muted-foreground"
            >
              No Available Logs
            </td>
          </tr>
        )}

        <tbody>
          {table.getRowModel().rows.map((row) => (
            <>
              <tr
                key={row.id}
                className={`p-2 hover:bg-muted hover:cursor-pointer ${row.getIsExpanded() && "bg-muted"}`}
                onClick={() => row.toggleExpanded()}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="p-2">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>

              {row.getIsExpanded() && (
                <tr>
                  <td
                    colSpan={table.getAllLeafColumns().length}
                    className="p-4 bg-muted/30"
                  >
                    <LogDetails row={row} />
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
};
