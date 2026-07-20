/**
 * Bridge integration with the REAL evals group (no groups mock): the second
 * consumer of the surface-tools lifecycle — mount registers the group
 * surface-scoped, `waitForUiToolNames` bridges the same-turn discovery path,
 * unmount removes everything.
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

const EVALS_TOOL_NAMES = [
  "ui_open_eval_suite_form",
  "ui_run_eval_suite",
  "ui_cancel_eval_run",
  "ui_generate_eval_tests",
  "ui_delete_eval_suite",
];

describe("evals group through useSurfaceAgentBridge", () => {
  beforeEach(() => {
    useUiToolsRegistry.setState({
      tools: new Map(),
      nativeDisposers: new Map(),
      globalNames: new Set(),
      shippedNames: new Set(),
    });
    __resetSurfaceSnapshotProvidersForTests();
  });

  it("listSurfaceGroupToolNames knows the evals group", () => {
    expect(listSurfaceGroupToolNames("evals")).toEqual(EVALS_TOOL_NAMES);
  });

  it("mount registers all five tools surface-scoped; unmount removes them", () => {
    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({
        surfaceId: "evals",
        snapshot: () => ({ totalSuites: 0 }),
      }),
    );

    const state = useUiToolsRegistry.getState();
    for (const name of EVALS_TOOL_NAMES) {
      expect(state.resolve(name), name).not.toBeNull();
      // Surface scope: behind the global catalog in the 64-entry snapshot cap.
      expect(state.globalNames.has(name), name).toBe(false);
    }
    expect(hasSurfaceSnapshotProvider("evals")).toBe(true);

    unmount();
    for (const name of EVALS_TOOL_NAMES) {
      expect(useUiToolsRegistry.getState().resolve(name), name).toBeNull();
    }
    expect(hasSurfaceSnapshotProvider("evals")).toBe(false);
  });

  it("waitForUiToolNames resolves once the just-mounted group is live (same-turn discovery)", async () => {
    // Start waiting BEFORE the mount — the App navigate handler's exact
    // ordering when the same turn navigates to /evals and then waits for
    // the group's tools.
    const pending = waitForUiToolNames(
      listSurfaceGroupToolNames("evals"),
      1_500,
    );

    const { unmount } = renderHook(() =>
      useSurfaceAgentBridge({ surfaceId: "evals" }),
    );

    await expect(pending).resolves.toBe(true);

    unmount();
    await expect(
      waitForUiToolNames(listSurfaceGroupToolNames("evals"), 50),
    ).resolves.toBe(false);
  });
});
