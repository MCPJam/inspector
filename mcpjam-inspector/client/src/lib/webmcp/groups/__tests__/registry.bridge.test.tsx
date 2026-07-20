/**
 * Bridge integration with the REAL registry group (no groups mock): the
 * first live proof of the surface-tools lifecycle — mount registers the
 * group surface-scoped, `waitForUiToolNames` bridges the same-turn discovery
 * path, unmount removes everything.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/webmcp/native-mirror", () => ({
  mirrorUiToolToNative: vi.fn(() => null),
}));

import { useUiToolsRegistry } from "../../ui-tools-registry";
import { waitForUiToolNames } from "../../ui-tools-readiness";
import { useSurfaceAgentBridge } from "../../use-surface-agent-bridge";
import {
  __resetSurfaceSnapshotProvidersForTests,
  hasSurfaceSnapshotProvider,
} from "../../surface-snapshot-registry";
import { listSurfaceGroupToolNames } from "../index";

const REGISTRY_TOOL_NAMES = [
  "ui_connect_registry_server",
  "ui_disconnect_registry_server",
  "ui_toggle_registry_star",
];

describe("registry group through useSurfaceAgentBridge", () => {
  beforeEach(() => {
    useUiToolsRegistry.setState({
      tools: new Map(),
      nativeDisposers: new Map(),
      globalNames: new Set(),
      shippedNames: new Set(),
    });
    __resetSurfaceSnapshotProvidersForTests();
  });

  it("listSurfaceGroupToolNames knows the registry group", () => {
    expect(listSurfaceGroupToolNames("registry")).toEqual(REGISTRY_TOOL_NAMES);
  });

  it("mount registers all three tools surface-scoped; unmount removes them", () => {
    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({
        surfaceId: "registry",
        snapshot: () => ({ totalServers: 0 }),
      }),
    );

    const state = useUiToolsRegistry.getState();
    for (const name of REGISTRY_TOOL_NAMES) {
      expect(state.resolve(name), name).not.toBeNull();
      // Surface scope: behind the global catalog in the 64-entry snapshot cap.
      expect(state.globalNames.has(name), name).toBe(false);
    }
    expect(hasSurfaceSnapshotProvider("registry")).toBe(true);

    unmount();
    for (const name of REGISTRY_TOOL_NAMES) {
      expect(useUiToolsRegistry.getState().resolve(name), name).toBeNull();
    }
    expect(hasSurfaceSnapshotProvider("registry")).toBe(false);
  });

  it("waitForUiToolNames resolves once the just-mounted group is live (same-turn discovery)", async () => {
    // Start waiting BEFORE the mount — the App navigate handler's exact
    // ordering when the same turn navigates to /registry and then waits for
    // the group's tools.
    const pending = waitForUiToolNames(
      listSurfaceGroupToolNames("registry"),
      1_500,
    );

    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({ surfaceId: "registry" }),
    );

    await expect(pending).resolves.toBe(true);

    unmount();
    await expect(
      waitForUiToolNames(listSurfaceGroupToolNames("registry"), 50),
    ).resolves.toBe(false);
  });
});
