/**
 * `useRunImportEligibility` — the canonical selected-run fetch.
 *
 * `run-detail-view.test.tsx` mocks this hook so it can hand the view a real
 * frozen projection, which means nothing there exercises the hook's own body.
 * These specs do, and they are about the things that are easy to get
 * backwards:
 *
 *   - it must SKIP the query when there is no run to ask about, rather than
 *     subscribing with an undefined id;
 *   - a run that carries no eligibility and a run that has not loaded yet must
 *     both surface as `undefined`, because every caller renders nothing for
 *     both — but only one of them is still `isLoading`;
 *   - a read that fails (the run was deleted while the page was open) must
 *     settle as absent instead of throwing into the render.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { getFunctionName } from "convex/server";

const useQueriesMock = vi.hoisted(() => vi.fn());

vi.mock("convex/react", () => ({
  useQueries: useQueriesMock,
  // `useQuery` re-throws a failed read during render, which is the behaviour
  // this hook must not have.
  useQuery: () => {
    throw new Error("Suite run not found");
  },
}));

import { useRunImportEligibility } from "../use-run-import-eligibility";
import type { ImportEligibility } from "../types";

const ELIGIBILITY: ImportEligibility = {
  status: "eligible",
  gateable: true,
  importedCaseCount: 1,
  claimedExactCaseIds: ["case_1"],
  approvedApproximationCaseIds: [],
  approvedApproximationReceipts: [],
  issues: [],
};

function answer(run: unknown) {
  useQueriesMock.mockImplementation((queries: Record<string, unknown>) =>
    "run" in queries ? { run } : {},
  );
}

function lastRequest() {
  return useQueriesMock.mock.calls.at(-1)?.[0] as Record<
    string,
    { query: Parameters<typeof getFunctionName>[0]; args: unknown }
  >;
}

describe("useRunImportEligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries the canonical single-run projection for the given run", () => {
    answer({ importEligibility: ELIGIBILITY });
    const { result } = renderHook(() => useRunImportEligibility("run-1"));
    // The run's OWN query, not the run-list projection — that one carries no
    // eligibility, so reading it would render every converted run as native.
    expect(getFunctionName(lastRequest().run.query)).toBe(
      "testSuites:getTestSuiteRun",
    );
    expect(lastRequest().run.args).toEqual({ runId: "run-1" });
    expect(result.current.eligibility).toEqual(ELIGIBILITY);
    expect(result.current.isLoading).toBe(false);
  });

  it.each([
    ["no run id", undefined],
    ["a null run id", null],
  ] as const)("skips the query given %s", (_label, runId) => {
    answer(undefined);
    const { result } = renderHook(() => useRunImportEligibility(runId));
    // Subscribing with an undefined id would ask the backend a question with
    // no subject; an empty request is how `useQueries` does not ask.
    expect(lastRequest()).toEqual({});
    expect(result.current.eligibility).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it("skips the query when explicitly disabled", () => {
    answer(undefined);
    const { result } = renderHook(() =>
      useRunImportEligibility("run-1", { enabled: false }),
    );
    expect(lastRequest()).toEqual({});
    expect(result.current.isLoading).toBe(false);
  });

  it("reports a pending query as loading with no eligibility", () => {
    answer(undefined);
    const { result } = renderHook(() => useRunImportEligibility("run-1"));
    expect(result.current.eligibility).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });

  it.each([
    ["a run that reports no eligibility", {}],
    ["a run the query could not find", null],
    // Deleting the open run re-runs the subscription against a missing row,
    // and the backend answers "Suite run not found" (Sentry CONVEX-19P).
    ["a read that failed", new Error("Suite run not found")],
  ] as const)("settles %s as absent, not loading", (_label, run) => {
    answer(run);
    const { result } = renderHook(() => useRunImportEligibility("run-1"));
    // Absent-and-settled is a different fact from still-loading: it says this
    // deployment has no opinion, which callers render as nothing rather than
    // as "no imported cases".
    expect(result.current.eligibility).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });
});
