import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEnvironmentResolutions } from "../suite-run-preflight";

const useQueries = vi.fn((_queries: unknown) => ({}));
vi.mock("convex/react", () => ({
  useQueries: (queries: unknown) => useQueries(queries),
}));

describe("useEnvironmentResolutions", () => {
  beforeEach(() => useQueries.mockClear());

  // Convex keys its subscription on the queries object: a new one every
  // render resubscribes, re-renders, and loops until React gives up.
  it("hands Convex the same queries object while the inputs are unchanged", () => {
    const { rerender } = renderHook(
      ({ ids }) => useEnvironmentResolutions("project-1", ids),
      { initialProps: { ids: ["env-a", "env-b"] } },
    );
    rerender({ ids: ["env-a", "env-b"] });
    expect(useQueries).toHaveBeenCalledTimes(2);
    expect(useQueries.mock.calls[1][0]).toBe(useQueries.mock.calls[0][0]);

    rerender({ ids: ["env-a"] });
    expect(useQueries.mock.calls[2][0]).not.toBe(useQueries.mock.calls[1][0]);
  });

  // Without the opt-in the backend answers OK for a group that still holds a
  // deleted server, and the launch fails only after Start.
  it("asks the backend to refuse servers that no longer exist", () => {
    renderHook(() => useEnvironmentResolutions("project-1", ["env-a"]));
    expect(useQueries).toHaveBeenCalledWith({
      "env-a": {
        query: "projectEnvironments:resolveEnvironmentForLaunch",
        args: {
          projectId: "project-1",
          environmentId: "env-a",
          serverSource: "environment_only",
          requireLiveServers: true,
        },
      },
    });
  });

  // Signed out, or a project id the backend would reject: subscribe to nothing.
  it("asks for nothing until it is enabled", () => {
    renderHook(() => useEnvironmentResolutions("project-1", ["env-a"], false));
    expect(useQueries).toHaveBeenCalledWith({});
  });
});
