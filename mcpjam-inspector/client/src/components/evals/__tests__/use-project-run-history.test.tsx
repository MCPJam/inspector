import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearProjectRunHistoryCache,
  useProjectRunHistory,
} from "../use-project-run-history";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
const client = { query: mocks.query };
vi.mock("convex/react", () => ({ useConvex: () => client }));
const rows = [{ _id: "one", status: "completed" }];

beforeEach(() => {
  clearProjectRunHistoryCache();
  mocks.query.mockReset();
  mocks.query.mockImplementation(async (name: string) =>
    name === "testSuites:getTestSuiteRun"
      ? { ...rows[0], runGroupId: "same" }
      : { page: [], isDone: true, continueCursor: "" },
  );
});

describe("project history snapshots", () => {
  it("keeps completed rows during refresh and isolates projects", async () => {
    const { result, rerender } = renderHook(
      ({ project }) => useProjectRunHistory(project, rows, true),
      { initialProps: { project: "first" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    const snapshot = result.current.details.get("one");
    let release!: (value: unknown) => void;
    mocks.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    act(() => result.current.retry());
    expect(result.current.loading).toBe(true);
    expect(result.current.details.get("one")).toBe(snapshot);
    await act(async () =>
      release({ ...rows[0], runGroupId: "same", result: "passed" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.details.get("one")?.run.result).toBe("passed");
    mocks.query.mockImplementation(() => new Promise(() => {}));
    rerender({ project: "second" });
    expect(result.current.details.size).toBe(0);
  });

  it("retains a previous snapshot on refresh failure and exposes retry", async () => {
    const { result } = renderHook(() =>
      useProjectRunHistory("first", rows, true),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.query.mockRejectedValue(new Error("offline"));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.errorCount).toBe(1));
    expect(result.current.details.has("one")).toBe(true);
    expect(result.current.loading).toBe(false);
  });
});

it("folds history metrics without fetching full run snapshots", async () => {
  const { result } = renderHook(() =>
    useProjectRunHistory("project", rows, true, { includeRunSnapshot: false }),
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.details.get("one")?.iterations).toEqual([]);
  expect(
    mocks.query.mock.calls.every(
      ([name]) => name !== "testSuites:getTestSuiteRun",
    ),
  ).toBe(true);
});

it("shows the last snapshot at once after an unmount, while it refreshes", async () => {
  const live = [{ _id: "live", status: "running" }];
  mocks.query.mockImplementation(async (name: string) =>
    name === "testSuites:getTestSuiteRun"
      ? { ...live[0], runGroupId: "same" }
      : { page: [], isDone: true, continueCursor: "" },
  );
  const first = renderHook(() => useProjectRunHistory("remount", live, true));
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  const snapshot = first.result.current.details.get("live");
  first.unmount();

  mocks.query.mockClear();
  mocks.query.mockImplementation(() => new Promise(() => {}));
  const second = renderHook(() => useProjectRunHistory("remount", live, true));
  expect(second.result.current.details.get("live")).toBe(snapshot);
  expect(second.result.current.loading).toBe(true);
  expect(mocks.query).toHaveBeenCalledWith("testSuites:getTestSuiteRun", {
    runId: "live",
  });
});
