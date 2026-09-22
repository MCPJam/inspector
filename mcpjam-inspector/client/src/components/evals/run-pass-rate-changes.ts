import type { ProjectRunRow } from "./project-runs-table";
import type { SuiteRunHistoryRow } from "../evaluate/suite-detail-model";

export type RunPassRateChange = { points: number; previousRunNumber: number };

/** Compare adjacent loaded runs in each suite, independently of display filters. */
export function buildRunPassRateChanges(
  rows: readonly ProjectRunRow[],
  historyRows: ReadonlyMap<string, SuiteRunHistoryRow>,
): Map<string, RunPassRateChange> {
  const previousBySuite = new Map<string, ProjectRunRow>();
  const changes = new Map<string, RunPassRateChange>();
  const measuredRate = (row: ProjectRunRow) => {
    if (
      !["completed", "failed", "timed_out"].includes(row.status) ||
      row.result === "inconclusive"
    )
      return null;
    const rate = historyRows.get(row._id)?.passRate;
    return rate != null && Number.isFinite(rate) ? rate : null;
  };
  const chronological = [...rows].sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      a.runNumber - b.runNumber ||
      a._id.localeCompare(b._id),
  );
  for (const row of chronological) {
    const previous = previousBySuite.get(row.suiteId);
    const rate = measuredRate(row);
    const previousRate = previous ? measuredRate(previous) : null;
    if (previous && rate != null && previousRate != null) {
      changes.set(row._id, {
        points: Math.round(rate - previousRate),
        previousRunNumber: previous.runNumber,
      });
    }
    // Missing or unfinished runs break the comparison; never skip an unknown baseline.
    previousBySuite.set(row.suiteId, row);
  }
  return changes;
}
