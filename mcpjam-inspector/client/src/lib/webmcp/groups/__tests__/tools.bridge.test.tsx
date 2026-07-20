/**
 * The SNAPSHOT-ONLY bridge path, proven against the Tools surface: a surface
 * can call `useSurfaceAgentBridge` with just a `snapshot` (no group, no
 * handlers). It flips `hasSnapshotProvider` WITHOUT registering any tool — Tools
 * has no SURFACE_TOOL_GROUPS entry because tool execution is already the global
 * `ui_execute_tool`, and a screen tool would duplicate it.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/webmcp/native-mirror", () => ({
  mirrorUiToolToNative: vi.fn(() => null),
}));

import { useUiToolsRegistry } from "../../ui-tools-registry";
import { useSurfaceAgentBridge } from "../../use-surface-agent-bridge";
import {
  __resetSurfaceSnapshotProvidersForTests,
  hasSurfaceSnapshotProvider,
  readSurfaceSnapshot,
} from "../../surface-snapshot-registry";
import { listSurfaceGroupToolNames, SURFACE_TOOL_GROUPS } from "../index";

describe("tools surface — snapshot-only bridge path", () => {
  beforeEach(() => {
    useUiToolsRegistry.setState({
      tools: new Map(),
      nativeDisposers: new Map(),
      globalNames: new Set(),
      shippedNames: new Set(),
    });
    __resetSurfaceSnapshotProvidersForTests();
  });

  it("has no tool group (execution is the global ui_execute_tool)", () => {
    expect(SURFACE_TOOL_GROUPS.tools).toBeUndefined();
    expect(listSurfaceGroupToolNames("tools")).toEqual([]);
  });

  it("mount registers ONLY a snapshot provider — no tools enter the registry", () => {
    const toolCountBefore = useUiToolsRegistry.getState().tools.size;
    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({
        surfaceId: "tools",
        snapshot: () => ({ toolCount: 2, selectedTool: null }),
      }),
    );

    // Snapshot provider is live, but the tool registry is untouched.
    expect(hasSurfaceSnapshotProvider("tools")).toBe(true);
    expect(useUiToolsRegistry.getState().tools.size).toBe(toolCountBefore);

    unmount();
    expect(hasSurfaceSnapshotProvider("tools")).toBe(false);
  });

  it("reads the redacted snapshot back through the registry", async () => {
    renderHook(() =>
      useSurfaceAgentBridge({
        surfaceId: "tools",
        snapshot: () => ({ toolCount: 2, selectedTool: "echo" }),
      }),
    );
    await expect(readSurfaceSnapshot("tools")).resolves.toMatchObject({
      ok: true,
      data: { toolCount: 2, selectedTool: "echo" },
    });
  });
});
