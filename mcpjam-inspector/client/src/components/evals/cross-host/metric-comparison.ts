import { formatTokens } from "./host-cell";
import type {
  HostCellMetricComparison,
  HostCellMetricComparisons,
  HostCellMetricKey,
} from "./host-cell";
import type { CellData, HostColumn } from "./use-cross-host-data";
import { formatRunCaseLatencyMs } from "../run-case-groups";

export function formatHostFallback(hostId: string): string {
  const tail = hostId.slice(-6);
  return `…${tail}`;
}

function metricValueForCell(
  metricKey: HostCellMetricKey,
  cell: CellData,
): number | null {
  if (metricKey === "p50") return cell.p50LatencyMs;
  if (metricKey === "p95") return cell.p95LatencyMs;
  return cell.avgTokensPerIteration;
}

function formatMetricValue(
  metricKey: HostCellMetricKey,
  value: number,
): string {
  if (metricKey === "avgTokens") return `${formatTokens(value)} tok`;
  return formatRunCaseLatencyMs(value);
}

// Build the sorted comparison entries for one row+metric. Returns undefined
// (rather than []) when no host in the row has the metric, so callers can
// skip rendering the tooltip entirely.
function buildBaseMetricEntries(
  metricKey: HostCellMetricKey,
  hostColumns: HostColumn[],
  byHost: Map<string, CellData> | undefined,
): Omit<HostCellMetricComparison, "isCurrent">[] | undefined {
  if (!byHost) return undefined;

  const entries = hostColumns
    .map((col) => {
      const cell = byHost.get(col.hostId);
      if (!cell) return null;
      const value = metricValueForCell(metricKey, cell);
      if (value == null) return null;
      return {
        hostId: col.hostId,
        hostName: col.hostName ?? formatHostFallback(col.hostId),
        value,
        formattedValue: formatMetricValue(metricKey, value),
      };
    })
    .filter(
      (entry): entry is Omit<HostCellMetricComparison, "isCurrent"> =>
        entry !== null,
    )
    .sort((a, b) => {
      if (a.value !== b.value) return a.value - b.value;
      return a.hostName.localeCompare(b.hostName);
    });

  return entries.length > 0 ? entries : undefined;
}

export type BaseMetricComparisons = Partial<
  Record<HostCellMetricKey, Omit<HostCellMetricComparison, "isCurrent">[]>
>;

// Computed once per row — every cell in the row reuses the same sorted lists.
export function buildBaseMetricComparisons(
  hostColumns: HostColumn[],
  byHost: Map<string, CellData> | undefined,
): BaseMetricComparisons {
  return {
    p50: buildBaseMetricEntries("p50", hostColumns, byHost),
    p95: buildBaseMetricEntries("p95", hostColumns, byHost),
    avgTokens: buildBaseMetricEntries("avgTokens", hostColumns, byHost),
  };
}

// Per cell: stamp isCurrent on the row's base comparison. Cheap O(N) over
// hosts (typical N ≤ 5) instead of re-sorting per cell.
export function projectComparisonsForHost(
  base: BaseMetricComparisons,
  currentHostId: string,
): HostCellMetricComparisons {
  const project = (
    entries: Omit<HostCellMetricComparison, "isCurrent">[] | undefined,
  ): HostCellMetricComparison[] | undefined =>
    entries?.map((entry) => ({
      ...entry,
      isCurrent: entry.hostId === currentHostId,
    }));

  return {
    p50: project(base.p50),
    p95: project(base.p95),
    avgTokens: project(base.avgTokens),
  };
}
