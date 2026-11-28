import { useCallback, useRef } from "react";

type GroupPositions = {
  groupId: string;
  byColumn: Map<string, number>;
  next: number;
};

/**
 * Hands each column of a multi-model session a position that only grows.
 * A replaced column (a new effort or model) gets a new position, so it never
 * shares one with the column it replaced, and a restored session continues
 * after the highest position it ever used, removed columns included. A column
 * that leaves the lineup gives up its key, so adding it back is a new column.
 */
export function useMultiModelPositions(groupId: string) {
  const state = useRef<GroupPositions>({
    groupId,
    byColumn: new Map(),
    next: 0,
  });
  if (state.current.groupId !== groupId) {
    state.current = { groupId, byColumn: new Map(), next: 0 };
  }
  const live = useRef<ReadonlySet<string>>(new Set());

  const positionFor = useCallback((columnKey: string): number => {
    const current = state.current;
    const known = current.byColumn.get(columnKey);
    if (known !== undefined) return known;
    const position = current.next;
    current.byColumn.set(columnKey, position);
    current.next = position + 1;
    return position;
  }, []);

  /** Adopts a restored session's positions before its columns mount. */
  const seed = useCallback(
    (
      seededGroupId: string,
      columns: readonly { columnKey: string; position: number }[],
      highestPosition: number,
    ) => {
      state.current = {
        groupId: seededGroupId,
        byColumn: new Map(
          columns.map((column) => [column.columnKey, column.position]),
        ),
        next: highestPosition + 1,
      };
    },
    [],
  );

  /**
   * Takes the keys of the columns on screen. A key that was on screen and is
   * gone gives up its position; a seeded key keeps its position until its
   * column has shown.
   */
  const syncLiveColumns = useCallback((columnKeys: readonly string[]) => {
    const next = new Set(columnKeys);
    for (const key of live.current) {
      if (!next.has(key)) state.current.byColumn.delete(key);
    }
    live.current = next;
  }, []);

  return { positionFor, seed, syncLiveColumns };
}
