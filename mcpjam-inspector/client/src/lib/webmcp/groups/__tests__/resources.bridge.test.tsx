/**
 * Bridge integration with the REAL resources group (no groups mock): mount
 * registers the group surface-scoped, `waitForUiToolNames` bridges the
 * same-turn discovery path, unmount removes everything.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUiToolsRegistry } from "../../ui-tools-registry";
import { waitForUiToolNames } from "../../ui-tools-readiness";
import { useSurfaceAgentBridge } from "../../use-surface-agent-bridge";
import {
  __resetSurfaceSnapshotProvidersForTests,
  hasSurfaceSnapshotProvider,
} from "../../surface-snapshot-registry";
import { listSurfaceGroupToolNames } from "../index";

const RESOURCE_TOOL_NAMES = ["ui_read_resource"];

describe("resources group through useSurfaceAgentBridge", () => {
  beforeEach(() => {
    useUiToolsRegistry.setState({
      tools: new Map(),
      globalNames: new Set(),
      shippedNames: new Set(),
    });
    __resetSurfaceSnapshotProvidersForTests();
  });

  it("listSurfaceGroupToolNames knows the resources group", () => {
    expect(listSurfaceGroupToolNames("resources")).toEqual(RESOURCE_TOOL_NAMES);
  });

  it("mount registers the read tool surface-scoped; unmount removes it", () => {
    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({
        surfaceId: "resources",
        snapshot: () => ({ resourceCount: 0 }),
      }),
    );

    const state = useUiToolsRegistry.getState();
    for (const name of RESOURCE_TOOL_NAMES) {
      expect(state.resolve(name), name).not.toBeNull();
      // Surface scope: behind the global catalog in the 64-entry snapshot cap.
      expect(state.globalNames.has(name), name).toBe(false);
    }
    expect(hasSurfaceSnapshotProvider("resources")).toBe(true);

    unmount();
    for (const name of RESOURCE_TOOL_NAMES) {
      expect(useUiToolsRegistry.getState().resolve(name), name).toBeNull();
    }
    expect(hasSurfaceSnapshotProvider("resources")).toBe(false);
  });

  it("waitForUiToolNames resolves once the just-mounted group is live (same-turn discovery)", async () => {
    const pending = waitForUiToolNames(
      listSurfaceGroupToolNames("resources"),
      1_500,
    );

    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({ surfaceId: "resources" }),
    );

    await expect(pending).resolves.toBe(true);

    unmount();
    await expect(
      waitForUiToolNames(listSurfaceGroupToolNames("resources"), 50),
    ).resolves.toBe(false);
  });
});
