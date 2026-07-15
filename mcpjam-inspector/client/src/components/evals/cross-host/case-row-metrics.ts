import { formatCompactNumber } from "../metric-strip-data";
import { formatRunCaseLatencyMs } from "../run-case-groups";
import {
  cellOutcome,
  type CellData,
  type HostColumn,
} from "./use-cross-host-data";

export type CaseRowSort =
  | "suite-order"
  | "latency"
  | "tokens"
  | "tool-calls"
  | "failures";

export type CaseRowMetrics = {
  p50Ms: number | null;
  tokens: number | null;
  toolCalls: number | null;
};

const CASE_ROW_SORT_LABELS: Record<CaseRowSort, string> = {
  "suite-order": "Suite order",
  latency: "Latency",
  tokens: "Tokens",
  "tool-calls": "Tool calls",
  failures: "Failures first",
};

export function caseRowSortLabel(sort: CaseRowSort): string {
  return CASE_ROW_SORT_LABELS[sort];
}

/** Mean tool calls per iteration in a cell snapshot. */
export function cellAvgToolCalls(cell: CellData): number | null {
  if (cell.iterations.length === 0) return null;
  return (
    cell.iterations.reduce(
      (sum, iter) => sum + (iter.actualToolCalls?.length ?? 0),
      0,
    ) / cell.iterations.length
  );
}

function maxNullable(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length === 0) return null;
  return Math.max(...nums);
}

export function aggregateCaseRowMetrics(
  cells: CellData[],
): CaseRowMetrics | null {
  const withData = cells.filter((cell) => cell.totalCount > 0);
  if (withData.length === 0) return null;

  const p50Ms = maxNullable(withData.map((cell) => cell.p50LatencyMs));
  const tokens = maxNullable(
    withData.map((cell) => cell.avgTokensPerIteration),
  );
  const toolCalls = maxNullable(withData.map(cellAvgToolCalls));

  if (p50Ms == null && tokens == null && toolCalls == null) return null;

  return { p50Ms, tokens, toolCalls };
}

function settledOutcomes(cells: CellData[]) {
  return cells
    .filter((cell) => cell.totalCount > 0)
    .map(cellOutcome)
    .filter((outcome) => outcome !== "running");
}

/**
 * Lower rank = sort earlier under "Failures first".
 * 0 all fail, 1 diverge, 2 partial, 3 all pass, 4 running/unsettled, 5 no data.
 */
export function caseRowFailureRank(cells: CellData[]): number {
  const withData = cells.filter((cell) => cell.totalCount > 0);
  if (withData.length === 0) return 5;

  const outcomes = settledOutcomes(withData);
  if (outcomes.length === 0) return 4;

  const passFlags = outcomes.map((o) => o === "pass");
  if (outcomes.length >= 2) {
    if (passFlags.every(Boolean)) return 3;
    if (passFlags.some(Boolean)) return 1;
    return 0;
  }

  const only = outcomes[0];
  if (only === "fail") return 0;
  if (only === "part") return 2;
  if (only === "pass") return 3;
  return 4;
}

export function liveHostColumns(hostColumns: HostColumn[]): HostColumn[] {
  return hostColumns.filter((col) => !col.isHistorical);
}

export function cellsForCaseRow(
  caseId: string,
  matrix: Map<string, Map<string, CellData>>,
  hostColumns: HostColumn[],
): CellData[] {
  const byHost = matrix.get(caseId);
  if (!byHost) return [];

  return liveHostColumns(hostColumns)
    .map((col) => byHost.get(col.hostId))
    .filter((cell): cell is CellData => cell != null);
}

function compareNullableDesc(
  a: number | null,
  b: number | null,
  titleA: string,
  titleB: string,
): number {
  if (a == null && b == null) return titleA.localeCompare(titleB);
  if (a == null) return 1;
  if (b == null) return -1;
  if (a !== b) return b - a;
  return titleA.localeCompare(titleB);
}

export function sortCaseRows<
  T extends { caseId: string; caseTitle: string },
>(
  rows: T[],
  matrix: Map<string, Map<string, CellData>>,
  hostColumns: HostColumn[],
  sortBy: CaseRowSort,
): T[] {
  if (sortBy === "suite-order") return rows;

  const indexed = rows.map((row, index) => ({ row, index }));

  indexed.sort((a, b) => {
    const cellsA = cellsForCaseRow(a.row.caseId, matrix, hostColumns);
    const cellsB = cellsForCaseRow(b.row.caseId, matrix, hostColumns);

    let cmp = 0;
    if (sortBy === "latency") {
      cmp = compareNullableDesc(
        aggregateCaseRowMetrics(cellsA)?.p50Ms ?? null,
        aggregateCaseRowMetrics(cellsB)?.p50Ms ?? null,
        a.row.caseTitle,
        b.row.caseTitle,
      );
    } else if (sortBy === "tokens") {
      cmp = compareNullableDesc(
        aggregateCaseRowMetrics(cellsA)?.tokens ?? null,
        aggregateCaseRowMetrics(cellsB)?.tokens ?? null,
        a.row.caseTitle,
        b.row.caseTitle,
      );
    } else if (sortBy === "tool-calls") {
      cmp = compareNullableDesc(
        aggregateCaseRowMetrics(cellsA)?.toolCalls ?? null,
        aggregateCaseRowMetrics(cellsB)?.toolCalls ?? null,
        a.row.caseTitle,
        b.row.caseTitle,
      );
    } else if (sortBy === "failures") {
      const rankA = caseRowFailureRank(cellsA);
      const rankB = caseRowFailureRank(cellsB);
      if (rankA !== rankB) cmp = rankA - rankB;
      else cmp = a.row.caseTitle.localeCompare(b.row.caseTitle);
    }

    if (cmp !== 0) return cmp;
    return a.index - b.index;
  });

  return indexed.map(({ row }) => row);
}

export function formatCaseRowSummary(metrics: CaseRowMetrics | null): string | null {
  if (!metrics) return null;

  const parts: string[] = [];
  if (metrics.p50Ms != null) {
    parts.push(formatRunCaseLatencyMs(metrics.p50Ms));
  }
  if (metrics.tokens != null) {
    parts.push(`${formatCompactNumber(metrics.tokens)} tok`);
  }
  if (metrics.toolCalls != null) {
    const rounded = Math.round(metrics.toolCalls);
    parts.push(`${rounded} ${rounded === 1 ? "call" : "calls"}`);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}
