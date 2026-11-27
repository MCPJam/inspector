import { useCallback, useRef } from "react";
import type { ComparisonAuthRecovery } from "@/lib/comparison-auth-recovery";

/**
 * Hands a restore record to each column once. The record stays in state after
 * its columns load, so a column that mounts again later (its model changed and
 * then changed back) would otherwise load the saved chat over the one it holds.
 */
export function useRecoveryColumnReads(record: ComparisonAuthRecovery | null) {
  const reads = useRef<{
    record: ComparisonAuthRecovery | null;
    columnKeys: Set<string>;
  }>({ record, columnKeys: new Set() });
  if (reads.current.record !== record) {
    reads.current = { record, columnKeys: new Set() };
  }

  /** The record for a column that has not read it yet, else null. */
  const recoveryFor = (columnKey: string) =>
    reads.current.columnKeys.has(columnKey) ? null : record;

  const markRead = useCallback((columnKey: string) => {
    reads.current.columnKeys.add(columnKey);
  }, []);

  return { recoveryFor, markRead };
}
