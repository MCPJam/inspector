/**
 * Bridge integration with the REAL oauth-flow group (no groups mock): mount
 * registers the group surface-scoped, `waitForUiToolNames` bridges the
 * same-turn discovery path, unmount removes everything.
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

const OAUTH_FLOW_TOOL_NAMES = [
  "ui_open_oauth_server_config",
  "ui_advance_oauth_flow",
  "ui_reset_oauth_flow",
];

describe("oauth-flow group through useSurfaceAgentBridge", () => {
  beforeEach(() => {
    useUiToolsRegistry.setState({
      tools: new Map(),
      nativeDisposers: new Map(),
      globalNames: new Set(),
      shippedNames: new Set(),
    });
    __resetSurfaceSnapshotProvidersForTests();
  });

  it("listSurfaceGroupToolNames knows the oauth-flow group", () => {
    expect(listSurfaceGroupToolNames("oauth-flow")).toEqual(
      OAUTH_FLOW_TOOL_NAMES,
    );
  });

  it("mount registers all three tools surface-scoped; unmount removes them", () => {
    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({
        surfaceId: "oauth-flow",
        snapshot: () => ({ configured: false }),
      }),
    );

    const state = useUiToolsRegistry.getState();
    for (const name of OAUTH_FLOW_TOOL_NAMES) {
      expect(state.resolve(name), name).not.toBeNull();
      // Surface scope: behind the global catalog in the 64-entry snapshot cap.
      expect(state.globalNames.has(name), name).toBe(false);
    }
    expect(hasSurfaceSnapshotProvider("oauth-flow")).toBe(true);

    unmount();
    for (const name of OAUTH_FLOW_TOOL_NAMES) {
      expect(useUiToolsRegistry.getState().resolve(name), name).toBeNull();
    }
    expect(hasSurfaceSnapshotProvider("oauth-flow")).toBe(false);
  });

  it("waitForUiToolNames resolves once the just-mounted group is live (same-turn discovery)", async () => {
    const pending = waitForUiToolNames(
      listSurfaceGroupToolNames("oauth-flow"),
      1_500,
    );

    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({ surfaceId: "oauth-flow" }),
    );

    await expect(pending).resolves.toBe(true);

    unmount();
    await expect(
      waitForUiToolNames(listSurfaceGroupToolNames("oauth-flow"), 50),
    ).resolves.toBe(false);
  });
});
