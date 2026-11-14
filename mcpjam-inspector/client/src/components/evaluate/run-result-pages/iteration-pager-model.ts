import {
  cellIterationOrder,
  type RunResultsMatrixData,
} from "../run-results-matrix-model";

export type PagerNeighbor = {
  caseKey: string;
  iterationId: string;
  /** "Iteration #n", numbered as the test case page numbers it. */
  label: string;
};

export type PagerPosition = {
  /** Zero-based. */
  index: number;
  total: number;
  prev?: PagerNeighbor;
  next?: PagerNeighbor;
};

/**
 * Where an iteration sits among its own test case's iterations on one client
 * and model, in the test case page's order. The pager never leaves the case.
 */
export function pagerPosition(
  matrix: Pick<RunResultsMatrixData, "targets">,
  columnKey: string,
  caseKey: string,
  iterationId: string,
): PagerPosition | null {
  const column = matrix.targets.find((target) => target.key === columnKey);
  if (!column) return null;
  const entries = cellIterationOrder(column.cells.get(caseKey) ?? []).map(
    ({ item, index }): PagerNeighbor => ({
      caseKey,
      iterationId: item._id,
      label: `Iteration #${item.iterationNumber ?? index + 1}`,
    }),
  );
  const index = entries.findIndex((entry) => entry.iterationId === iterationId);
  if (index < 0) return null;
  return {
    index,
    total: entries.length,
    prev: entries[index - 1],
    next: entries[index + 1],
  };
}
