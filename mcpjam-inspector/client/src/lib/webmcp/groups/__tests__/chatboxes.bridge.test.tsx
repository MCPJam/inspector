/**
 * Bridge integration with the REAL chatboxes group (no groups mock): the sixth
 * consumer of the surface-tools lifecycle — mount registers the group
 * surface-scoped, `waitForUiToolNames` bridges the same-turn discovery path,
 * unmount removes everything.
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

const CHATBOX_TOOL_NAMES = [
  "ui_publish_chatbox",
  "ui_delete_chatbox",
];

describe("chatboxes group through useSurfaceAgentBridge", () => {
  beforeEach(() => {
    useUiToolsRegistry.setState({
      tools: new Map(),
      globalNames: new Set(),
      shippedNames: new Set(),
    });
    __resetSurfaceSnapshotProvidersForTests();
  });

  it("listSurfaceGroupToolNames knows the chatboxes group", () => {
    expect(listSurfaceGroupToolNames("chatboxes")).toEqual(CHATBOX_TOOL_NAMES);
  });

  it("mount registers both tools surface-scoped; unmount removes them", () => {
    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({
        surfaceId: "chatboxes",
        snapshot: () => ({ published: false }),
      }),
    );

    const state = useUiToolsRegistry.getState();
    for (const name of CHATBOX_TOOL_NAMES) {
      expect(state.resolve(name), name).not.toBeNull();
      // Surface scope: behind the global catalog in the 64-entry snapshot cap.
      expect(state.globalNames.has(name), name).toBe(false);
    }
    expect(hasSurfaceSnapshotProvider("chatboxes")).toBe(true);

    unmount();
    for (const name of CHATBOX_TOOL_NAMES) {
      expect(useUiToolsRegistry.getState().resolve(name), name).toBeNull();
    }
    expect(hasSurfaceSnapshotProvider("chatboxes")).toBe(false);
  });

  it("waitForUiToolNames resolves once the just-mounted group is live (same-turn discovery)", async () => {
    // Start waiting BEFORE the mount — the App navigate handler's exact
    // ordering when the same turn navigates to the Chatboxes screen and then
    // waits for the group's tools.
    const pending = waitForUiToolNames(
      listSurfaceGroupToolNames("chatboxes"),
      1_500,
    );

    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({ surfaceId: "chatboxes" }),
    );

    await expect(pending).resolves.toBe(true);

    unmount();
    await expect(
      waitForUiToolNames(listSurfaceGroupToolNames("chatboxes"), 50),
    ).resolves.toBe(false);
  });
});
