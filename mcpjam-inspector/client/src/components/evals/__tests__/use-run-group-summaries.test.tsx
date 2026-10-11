import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
const client = { query: mocks.query };
vi.mock("convex/react", () => ({ useConvex: () => client }));
import {
  readRunGroupSummaries,
  useRunGroupSummaries,
} from "../use-run-group-summaries";
beforeEach(() => mocks.query.mockReset());
it("finishes split groups, crosses hidden pages, and removes duplicates", async () => {
  mocks.query
    .mockResolvedValueOnce({
      page: [{ _id: "one" }],
      isDone: false,
      continueCursor: "a",
    })
    .mockResolvedValueOnce({ page: [], isDone: false, continueCursor: "b" })
    .mockResolvedValueOnce({
      page: [{ _id: "one" }, { _id: "two" }],
      isDone: true,
      continueCursor: "",
    });
  expect(
    (await readRunGroupSummaries(mocks.query, "suite", "group")).map(
      (row) => row._id,
    ),
  ).toEqual(["one", "two"]);
  expect(mocks.query).toHaveBeenNthCalledWith(
    2,
    "testSuites:listTestSuiteRunSummaries",
    {
      suiteId: "suite",
      runGroupId: "group",
      paginationOpts: { numItems: 20, cursor: "a" },
    },
  );
});
it("refuses incomplete groups rather than comparing or deleting a partial group", async () => {
  mocks.query.mockResolvedValue({
    page: [],
    isDone: false,
    continueCursor: "same",
  });
  await expect(
    readRunGroupSummaries(mocks.query, "suite", "group"),
  ).rejects.toThrow("incomplete");
});
it("merges live rows, forgets deleted members, and isolates suite changes", async () => {
  mocks.query.mockResolvedValue({
    page: [{ _id: "one", status: "running" }, { _id: "two" }],
    isDone: true,
    continueCursor: "",
  });
  const { result, rerender } = renderHook(
    ({ suite, runs }) => useRunGroupSummaries(suite, runs),
    {
      initialProps: {
        suite: "first",
        runs: [{ _id: "one", status: "completed" }] as any[],
      },
    },
  );
  await act(async () => {
    await result.current.loadGroup("group");
  });
  expect(result.current.runs.find((row) => row._id === "one")?.status).toBe(
    "completed",
  );
  expect(result.current.runs).toHaveLength(2);
  act(() => result.current.forgetRuns(["two"]));
  expect(result.current.runs).toHaveLength(1);
  rerender({ suite: "second", runs: [] });
  expect(result.current.runs).toEqual([]);
});

it("blocks actions when a group is deleted or access is revoked", async () => {
  mocks.query.mockResolvedValue({ page: [], isDone: true, continueCursor: "" });
  await expect(readRunGroupSummaries(mocks.query, "suite", "group")).rejects.toThrow("unavailable");
});
