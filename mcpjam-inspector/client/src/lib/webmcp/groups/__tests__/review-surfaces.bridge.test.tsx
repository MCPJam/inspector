/**
 * The SNAPSHOT-ONLY bridge path for the S9 read-only REVIEW surfaces, proven
 * the same way the Tools surface (S8) proved it: a surface can call
 * `useSurfaceAgentBridge` with just a `snapshot` (no group, no handlers). It
 * flips `hasSnapshotProvider` WITHOUT registering any tool — these surfaces
 * stay `agentTools: { kind: "none" }` because there is nothing for the agent to
 * operate; they only expose state for observation.
 *
 * Covers two of the five S9 surfaces (tasks + tracing); the remaining three
 * ride the same one bridge hook and are exercised by the coverage suites.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUiToolsRegistry } from "../../ui-tools-registry";
import { useSurfaceAgentBridge } from "../../use-surface-agent-bridge";
import {
  __resetSurfaceSnapshotProvidersForTests,
  hasSurfaceSnapshotProvider,
  readSurfaceSnapshot,
} from "../../surface-snapshot-registry";
import {
  buildTasksSnapshot,
  buildTracingSnapshot,
} from "../../review-surface-snapshots";
import { listSurfaceGroupToolNames, SURFACE_TOOL_GROUPS } from "../index";

describe("S9 review surfaces — snapshot-only bridge path", () => {
  beforeEach(() => {
    useUiToolsRegistry.setState({
      tools: new Map(),
      globalNames: new Set(),
      shippedNames: new Set(),
    });
    __resetSurfaceSnapshotProvidersForTests();
  });

  it("neither surface declares a tool group (review screens don't operate)", () => {
    expect(SURFACE_TOOL_GROUPS.tasks).toBeUndefined();
    expect(SURFACE_TOOL_GROUPS.tracing).toBeUndefined();
    expect(listSurfaceGroupToolNames("tasks")).toEqual([]);
    expect(listSurfaceGroupToolNames("tracing")).toEqual([]);
  });

  it("tasks: mount registers ONLY a snapshot provider — zero tools enter the registry", () => {
    const toolCountBefore = useUiToolsRegistry.getState().tools.size;
    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({
        surfaceId: "tasks",
        snapshot: () =>
          buildTasksSnapshot({
            selectedServer: "srv-1",
            tasks: [{ taskId: "t1", status: "working", createdAt: "2026-07-18" }],
            selectedTaskId: "t1",
            hasActiveTasks: true,
            autoRefresh: true,
            selectedProgress: { progress: 1, total: 4 },
          }),
      }),
    );

    expect(hasSurfaceSnapshotProvider("tasks")).toBe(true);
    expect(useUiToolsRegistry.getState().tools.size).toBe(toolCountBefore);

    unmount();
    expect(hasSurfaceSnapshotProvider("tasks")).toBe(false);
  });

  it("tracing: mount registers ONLY a snapshot provider — zero tools enter the registry", () => {
    const toolCountBefore = useUiToolsRegistry.getState().tools.size;
    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({
        surfaceId: "tracing",
        snapshot: () =>
          buildTracingSnapshot({ serverItems: [], appItems: [] }),
      }),
    );

    expect(hasSurfaceSnapshotProvider("tracing")).toBe(true);
    expect(useUiToolsRegistry.getState().tools.size).toBe(toolCountBefore);

    unmount();
    expect(hasSurfaceSnapshotProvider("tracing")).toBe(false);
  });

  it("reads the redacted tasks snapshot back through the registry", async () => {
    renderHook(() =>
      useSurfaceAgentBridge({
        surfaceId: "tasks",
        snapshot: () =>
          buildTasksSnapshot({
            selectedServer: "srv-1",
            tasks: [{ taskId: "t1", status: "completed", createdAt: "2026-07-18" }],
            selectedTaskId: null,
            hasActiveTasks: false,
            autoRefresh: false,
            selectedProgress: null,
          }),
      }),
    );
    await expect(readSurfaceSnapshot("tasks")).resolves.toMatchObject({
      ok: true,
      data: {
        selectedServer: "srv-1",
        taskCount: 1,
        tasks: [{ taskId: "t1", status: "completed" }],
      },
    });
  });
});
