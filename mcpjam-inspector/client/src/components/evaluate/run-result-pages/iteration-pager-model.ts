import { ALL_EVAL_FILTER_VALUES } from "../../evals/eval-list-filter";
import {
  cellIterationOrder,
  cellResult,
  type RunResultsMatrixData,
} from "../run-results-matrix-model";

export type PagerNeighbor = {
  caseKey: string;
  caseTitle: string;
  iterationId: string;
};

export type PagerPosition = {
  /** Zero-based. */
  index: number;
  total: number;
  prev?: PagerNeighbor;
  next?: PagerNeighbor;
};

/** The grid filters the pager follows; see `run-view-memory.ts`. */
export type PagerFilters = { search?: string; status?: string };

/**
 * Where an iteration sits in its column: grid row order, then each cell's
 * test case page order. Search filters rows as the grid does; the status
 * filter reads this column's own cell, so "Failed" walks only what failed on
 * this client and model.
 */
export function pagerPosition(
  matrix: Pick<RunResultsMatrixData, "rows" | "targets">,
  columnKey: string,
  iterationId: string,
  filters: PagerFilters = {},
): PagerPosition | null {
  const column = matrix.targets.find((target) => target.key === columnKey);
  if (!column) return null;
  const walk = (query: string, status: string): PagerNeighbor[] =>
    matrix.rows
      .filter((row) => row.title.toLowerCase().includes(query))
      .flatMap((row) => {
        const cell = column.cells.get(row.key) ?? [];
        if (status !== ALL_EVAL_FILTER_VALUES && cellResult(cell) !== status)
          return [];
        return cellIterationOrder(cell).map(({ item }) => ({
          caseKey: row.key,
          caseTitle: row.title,
          iterationId: item._id,
        }));
      });
  const filtered = walk(
    filters.search?.trim().toLowerCase() ?? "",
    filters.status ?? ALL_EVAL_FILTER_VALUES,
  );
  // A link opened outside the filtered grid still gets a pager.
  const entries = filtered.some((entry) => entry.iterationId === iterationId)
    ? filtered
    : walk("", ALL_EVAL_FILTER_VALUES);
  const index = entries.findIndex((entry) => entry.iterationId === iterationId);
  if (index < 0) return null;
  return {
    index,
    total: entries.length,
    prev: entries[index - 1],
    next: entries[index + 1],
  };
}
