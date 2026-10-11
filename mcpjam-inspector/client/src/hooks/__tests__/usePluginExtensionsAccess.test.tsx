import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryState = vi.hoisted(() => ({
  calls: [] as unknown[],
  next: undefined as unknown,
}));

vi.mock("convex/react", () => ({
  useQuery: (_ref: unknown, args: unknown) => {
    queryState.calls.push(args);
    if (args === "skip") return undefined;
    if (queryState.next instanceof Error) throw queryState.next;
    return queryState.next;
  },
}));

import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { usePluginExtensionsAccess } from "../usePluginExtensionsAccess";

const admitted = {
  flag: true,
  isAuthenticated: true,
  projectId: "project-1",
};

describe("usePluginExtensionsAccess", () => {
  beforeEach(() => {
    queryState.calls = [];
    queryState.next = undefined;
    useTrafficLogStore.getState().clear();
  });

  it("skips the query while the flag is off", () => {
    const { result } = renderHook(() =>
      usePluginExtensionsAccess({ ...admitted, flag: false }),
    );
    expect(result.current).toEqual({ enabled: false, status: "skipped" });
    expect(queryState.calls).toEqual(["skip"]);
  });

  it("is off while loading and follows the backend once ready", () => {
    const { result, rerender } = renderHook(() =>
      usePluginExtensionsAccess(admitted),
    );
    expect(result.current).toEqual({ enabled: false, status: "loading" });
    queryState.next = { enabled: true };
    rerender();
    expect(result.current).toEqual({ enabled: true, status: "ready" });
    queryState.next = { enabled: false };
    rerender();
    expect(result.current).toEqual({ enabled: false, status: "ready" });
  });

  it("reads a missing backend query as off instead of throwing", () => {
    queryState.next = new Error(
      "[CONVEX Q(plugins:getPluginExtensionAccess)] Could not find public function",
    );
    const { result, rerender } = renderHook(() =>
      usePluginExtensionsAccess(admitted),
    );
    expect(result.current).toEqual({ enabled: false, status: "unavailable" });
    rerender();

    const entries = useTrafficLogStore
      .getState()
      .mcpServerItems.filter(
        (item) =>
          item.method === "plugin-extensions/PLUGIN_EXTENSIONS_ACCESS_UNAVAILABLE",
      );
    // One Logs entry, not one per render.
    expect(entries).toHaveLength(1);
    expect(entries[0].payload).toMatchObject({
      level: "warning",
      projectId: "project-1",
    });
  });
});
