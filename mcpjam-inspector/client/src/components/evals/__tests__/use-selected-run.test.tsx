import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  answer: undefined as any,
  queries: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQueries: (queries: unknown) => {
    mocks.queries(queries);
    return { selectedRun: mocks.answer };
  },
}));
import { useSelectedRun } from "../use-selected-run";
beforeEach(() => {
  mocks.answer = undefined;
  mocks.queries.mockClear();
});
it("opens an older run without depending on loaded pages", () => {
  const { result, rerender } = renderHook(() =>
    useSelectedRun("suite", "older"),
  );
  expect(result.current.isLoading).toBe(true);
  expect(mocks.queries.mock.lastCall?.[0].selectedRun.args).toEqual({
    runId: "older",
  });
  mocks.answer = {
    _id: "older",
    suiteId: "suite",
    configSnapshot: { tests: [{ query: "saved" }] },
  };
  rerender();
  expect(result.current.run?.configSnapshot.tests[0].query).toBe("saved");
  expect(result.current.isLoading).toBe(false);
});
it("clears the old run when switching suites and shows unavailable results", () => {
  mocks.answer = { _id: "run", suiteId: "first" };
  const { result, rerender } = renderHook(
    ({ suite }) => useSelectedRun(suite, "run"),
    { initialProps: { suite: "first" } },
  );
  rerender({ suite: "second" });
  expect(result.current.run).toBeNull();
  expect(result.current.isUnavailable).toBe(true);
  mocks.answer = new Error("Access denied");
  rerender({ suite: "second" });
  expect(result.current.isUnavailable).toBe(true);
  mocks.answer = null;
  rerender({ suite: "second" });
  expect(result.current.isUnavailable).toBe(true);
});
