/**
 * App-level coordinator that watches all workspace servers for connection
 * transitions and runs the inspection pipeline (snapshot + diff) after
 * each successful connect.
 *
 * Mounted via a zero-UI bridge component inside AppStateProvider so it
 * has access to useSharedAppState().
 *
 * Key design decisions:
 *  - Captures workspaceId + serverName before async work
 *  - Verifies they still match after async work completes
 *  - Incomplete pagination = skip diff, keep previous baseline
 *  - Never overwrites previous record on error
 *  - Shows rich toast with "View changes" CTA only when diff has changes
 */

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { ServerWithName, ConnectionStatus } from "@/state/app-types";
import { useSharedAppState } from "@/state/app-state-context";
import { listTools, type ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import { buildSnapshot, computeInspectionDiff, hasMeaningfulChanges } from "@/lib/inspection/diff-engine";
import { formatDiffSummary } from "@/lib/inspection/diff-summary";
import { useInspectionStore, inspectionStoreKey } from "@/stores/inspection-store";

interface ServerTrack {
  status: ConnectionStatus;
  hasInitInfo: boolean;
}

/**
 * Fetch the complete tool catalog, following all pagination cursors.
 * Returns null if pagination is incomplete (e.g. mid-pagination error).
 */
async function fetchAllTools(
  serverId: string,
): Promise<ListToolsResultWithMetadata | null> {
  let allTools: ListToolsResultWithMetadata["tools"] = [];
  let allMetadata: Record<string, Record<string, any>> = {};
  let cursor: string | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let page: ListToolsResultWithMetadata;
    try {
      page = await listTools({ serverId, cursor });
    } catch (error) {
      // Mid-pagination failure — return null to signal incomplete
      console.warn(
        `[inspection] Failed to fetch tools page for ${serverId}:`,
        error,
      );
      return null;
    }

    allTools = allTools.concat(page.tools ?? []);
    if (page.toolsMetadata) {
      allMetadata = { ...allMetadata, ...page.toolsMetadata };
    }

    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return {
    tools: allTools,
    toolsMetadata: Object.keys(allMetadata).length > 0 ? allMetadata : undefined,
  };
}

export function useInspectionCoordinator(
  workspaceServers: Record<string, ServerWithName>,
  onViewChanges: (serverName: string) => void,
): void {
  const { activeWorkspaceId } = useSharedAppState();

  // Track previous state per server to detect transitions
  const prevTrackRef = useRef<Record<string, ServerTrack>>({});
  // Pending inspection flags — set when connected but awaiting initInfo
  const pendingRef = useRef<Set<string>>(new Set());
  // In-flight set to prevent concurrent inspections for the same server
  const inFlightRef = useRef<Set<string>>(new Set());
  // Cancellation: increment to invalidate all in-flight work
  const generationRef = useRef(0);

  // Reset pending/in-flight when workspace changes
  const prevWorkspaceRef = useRef(activeWorkspaceId);
  if (prevWorkspaceRef.current !== activeWorkspaceId) {
    prevWorkspaceRef.current = activeWorkspaceId;
    pendingRef.current.clear();
    generationRef.current++;
  }

  useEffect(() => {
    const prevTrack = prevTrackRef.current;
    const nextTrack: Record<string, ServerTrack> = {};

    for (const [name, server] of Object.entries(workspaceServers)) {
      const prev = prevTrack[name];
      const status = server.connectionStatus;
      const hasInitInfo = server.initializationInfo != null;

      nextTrack[name] = { status, hasInitInfo };

      // Detect transition to connected (only if we have a previous state —
      // first render just records the baseline, doesn't trigger inspection)
      if (status === "connected" && prev != null && prev.status !== "connected") {
        pendingRef.current.add(name);
      }

      // If disconnected/failed, clear pending
      if (status !== "connected") {
        pendingRef.current.delete(name);
        continue;
      }

      // Run inspection when pending AND initInfo is populated
      if (!pendingRef.current.has(name) || !hasInitInfo) continue;
      if (inFlightRef.current.has(name)) continue;

      pendingRef.current.delete(name);
      inFlightRef.current.add(name);

      // Capture at scheduling time
      const capturedWorkspaceId = activeWorkspaceId;
      const capturedServerName = name;
      const capturedGeneration = generationRef.current;
      const initInfo = server.initializationInfo!;

      void (async () => {
        try {
          // Fetch complete tool catalog
          const toolsResult = await fetchAllTools(capturedServerName);

          // Incomplete pagination — skip diff
          if (!toolsResult) {
            console.warn(
              `[inspection] Incomplete tool catalog for ${capturedServerName}, skipping diff`,
            );
            return;
          }

          // Verify workspace hasn't changed (generation check covers workspace switches)
          if (capturedGeneration !== generationRef.current) return;

          const snapshot = buildSnapshot(initInfo, toolsResult);
          const storeKey = inspectionStoreKey(
            capturedWorkspaceId,
            capturedServerName,
          );

          const prevRecord =
            useInspectionStore.getState().getRecord(storeKey);

          if (!prevRecord) {
            // First connect — seed baseline, no diff
            useInspectionStore
              .getState()
              .saveInspection(storeKey, snapshot, null);
            return;
          }

          // Compute diff
          const diff = computeInspectionDiff(
            prevRecord.latestSnapshot,
            snapshot,
          );
          useInspectionStore
            .getState()
            .saveInspection(storeKey, snapshot, diff);

          if (hasMeaningfulChanges(diff)) {
            const summary = formatDiffSummary(diff);
            toast("Server changes detected", {
              description: `${capturedServerName}: ${summary}`,
              duration: 8000,
              action: {
                label: "View changes",
                onClick: () => onViewChanges(capturedServerName),
              },
            });
          }
        } catch (error) {
          // Never overwrite previous record on error
          console.error(
            `[inspection] Inspection failed for ${capturedServerName}:`,
            error,
          );
        } finally {
          inFlightRef.current.delete(capturedServerName);
        }
      })();
    }

    // Clean up servers that disappeared from workspaceServers
    for (const name of Object.keys(prevTrack)) {
      if (!(name in workspaceServers)) {
        pendingRef.current.delete(name);
      }
    }

    prevTrackRef.current = nextTrack;
  }, [workspaceServers, activeWorkspaceId, onViewChanges]);
}
