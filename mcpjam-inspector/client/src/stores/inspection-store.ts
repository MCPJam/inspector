/**
 * Zustand store for MCP server inspection snapshots and diffs.
 *
 * Persisted to localStorage under "mcp-inspector-inspections".
 * Completely separate from AppState / app-reducer — no Convex interaction.
 *
 * Keys are "{workspaceId}::{serverName}".
 * Each key maps to one atomic record containing both the latest snapshot
 * and the latest diff (or null if this is the first connect).
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  ServerInspectionRecord,
  ServerInspectionSnapshot,
  ServerInspectionDiff,
} from "@/lib/inspection/types";

export interface InspectionStoreState {
  records: Record<string, ServerInspectionRecord>;

  saveInspection: (
    key: string,
    snapshot: ServerInspectionSnapshot,
    diff: ServerInspectionDiff | null,
  ) => void;
  getRecord: (key: string) => ServerInspectionRecord | undefined;
  clearForServer: (key: string) => void;
}

export function inspectionStoreKey(
  workspaceId: string,
  serverName: string,
): string {
  return `${workspaceId}::${serverName}`;
}

export const useInspectionStore = create<InspectionStoreState>()(
  persist(
    (set, get) => ({
      records: {},

      saveInspection: (key, snapshot, diff) =>
        set((state) => ({
          records: {
            ...state.records,
            [key]: { latestSnapshot: snapshot, latestDiff: diff },
          },
        })),

      getRecord: (key) => get().records[key],

      clearForServer: (key) =>
        set((state) => {
          const { [key]: _, ...rest } = state.records;
          return { records: rest };
        }),
    }),
    {
      name: "mcp-inspector-inspections",
      version: 1,
    },
  ),
);
