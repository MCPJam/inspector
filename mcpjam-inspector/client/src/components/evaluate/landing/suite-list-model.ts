import type { EvalSuiteOverviewEntry } from "../../evals/types";
import { buildSuiteRunSlice, type SuiteRunSlice } from "./suite-run-slice";

export type SuiteSort = "recent" | "name" | "passRate";

export const SUITE_SORTS: ReadonlyArray<{ value: SuiteSort; label: string }> = [
  { value: "recent", label: "Last run" },
  { value: "name", label: "Name" },
  { value: "passRate", label: "Pass rate (lowest first)" },
];

export interface SuiteRow {
  entry: EvalSuiteOverviewEntry;
  slice: SuiteRunSlice;
}

export function suiteName(entry: EvalSuiteOverviewEntry): string {
  return entry.suite.name || "Untitled suite";
}

/** Suites matching `query` by name, in `sort` order. Suites with no run sort last by pass rate. */
export function buildSuiteRows(
  entries: readonly EvalSuiteOverviewEntry[],
  sort: SuiteSort,
  query: string,
): SuiteRow[] {
  const needle = query.trim().toLowerCase();
  const rows = entries
    .filter((entry) => suiteName(entry).toLowerCase().includes(needle))
    .map((entry) => ({ entry, slice: buildSuiteRunSlice(entry) }));
  if (sort === "name") {
    return rows.sort((a, b) =>
      suiteName(a.entry).localeCompare(suiteName(b.entry)),
    );
  }
  if (sort === "passRate") {
    return rows.sort(
      (a, b) => (a.slice.average ?? Infinity) - (b.slice.average ?? Infinity),
    );
  }
  return rows.sort((a, b) => lastActivity(b) - lastActivity(a));
}

function lastActivity({ entry }: SuiteRow): number {
  const run = entry.latestRun;
  return run?.completedAt ?? run?.createdAt ?? entry.suite._creationTime ?? 0;
}
