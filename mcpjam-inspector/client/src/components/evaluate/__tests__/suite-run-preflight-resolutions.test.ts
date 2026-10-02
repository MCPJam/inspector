import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEnvironmentResolutions } from "../suite-run-preflight";

const useQueries = vi.fn((_queries: unknown) => ({}));
vi.mock("convex/react", () => ({
  useQueries: (queries: unknown) => useQueries(queries),
}));

describe("useEnvironmentResolutions", () => {
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

  // Signed out, or a project id the backend would reject: subscribe to nothing.
  it("asks for nothing until it is enabled", () => {
    useQueries.mockClear();
    renderHook(() => useEnvironmentResolutions("project-1", ["env-a"], false));
    expect(useQueries).toHaveBeenCalledWith({});
  });
});
