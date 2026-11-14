import { useCallback, useRef } from "react";

type GroupPositions = { groupId: string; byColumn: Map<string, number>; next: number };

/**
 * Hands each column of a multi-model session a position that only grows.
 * A replaced column (a new effort or model) gets a new position, so it never
 * shares one with the column it replaced, and a restored session continues
 * after the highest position it ever used, removed columns included.
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

  const positionFor = useCallback(
    (columnKey: string): number => {
      const current = state.current;
      const known = current.byColumn.get(columnKey);
      if (known !== undefined) return known;
      const position = current.next;
      current.byColumn.set(columnKey, position);
      current.next = position + 1;
      return position;
    },
    [],
  );

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

  return { positionFor, seed };
}
