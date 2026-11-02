import { renderHook } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseQueries = vi.fn();
vi.mock("convex/react", () => ({
  useQueries: (queries: unknown) => mockUseQueries(queries),
  useMutation: () => vi.fn(),
}));

import { useConformanceServerData } from "../use-conformance-server-data";

const serversById = new Map([["srv_1", "alpha"]]);
const serversByName = new Map([["alpha", "srv_1"]]);

function queryName(queries: {
  result?: { query: FunctionReference<"query"> };
}) {
  return queries?.result ? getFunctionName(queries.result.query) : undefined;
}

describe("useConformanceServerData", () => {
  beforeEach(() => mockUseQueries.mockReset());

  it("reads defaults and each server's latest run by name", () => {
    mockUseQueries.mockImplementation((queries) =>
      queryName(queries) === "conformanceSettings:listServerSettings"
        ? { result: [{ serverId: "srv_1", defaultChecks: { oauth: false } }] }
        : { result: [{ _id: "run_new", serverId: "srv_1" }] },
    );
    const { result } = renderHook(() =>
      useConformanceServerData({
        projectId: "proj_1",
        serversById,
        serversByName,
      }),
    );

    expect(result.current.defaultsByServer).toEqual({
      alpha: { oauth: false },
    });
    expect(result.current.lastRunByServer.alpha?._id).toBe("run_new");
    expect(result.current.saveDefaults).toBeDefined();
  });

  it("keeps the page up when the backend lacks the settings function", () => {
    mockUseQueries.mockImplementation((queries) =>
      queryName(queries) === "conformanceSettings:listServerSettings"
        ? {
            result: new Error(
              "Could not find public function for 'conformanceSettings:listServerSettings'",
            ),
          }
        : { result: [] },
    );
    const { result } = renderHook(() =>
      useConformanceServerData({
        projectId: "proj_1",
        serversById,
        serversByName,
      }),
    );

    expect(result.current.defaultsByServer).toEqual({});
    // Nothing to save to: Settings stays hidden.
    expect(result.current.saveDefaults).toBeUndefined();
  });

  it("drops saved check ids this build does not know", () => {
    mockUseQueries.mockImplementation((queries) =>
      queryName(queries) === "conformanceSettings:listServerSettings"
        ? {
            result: [
              {
                serverId: "srv_1",
                defaultChecks: { protocol: ["ping", "renamed-check"] },
              },
            ],
          }
        : { result: [] },
    );
    const { result } = renderHook(() =>
      useConformanceServerData({
        projectId: "proj_1",
        serversById,
        serversByName,
      }),
    );

    expect(result.current.defaultsByServer.alpha?.protocol).toEqual(["ping"]);
  });

  it("reports the defaults as loading until they are read", () => {
    mockUseQueries.mockImplementation(() => ({}));
    const { result } = renderHook(() =>
      useConformanceServerData({
        projectId: "proj_1",
        serversById,
        serversByName,
      }),
    );

    expect(result.current.defaultsLoaded).toBe(false);
  });

  it("fails the save for a server it cannot save to", async () => {
    mockUseQueries.mockImplementation((queries) =>
      queryName(queries) === "conformanceSettings:listServerSettings"
        ? { result: [] }
        : { result: [] },
    );
    const { result } = renderHook(() =>
      useConformanceServerData({
        projectId: "proj_1",
        serversById,
        serversByName,
      }),
    );

    await expect(
      result.current.saveDefaults!("unsaved", { oauth: false }),
    ).rejects.toThrow();
  });
});
