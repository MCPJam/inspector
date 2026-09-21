/**
 * `useRunImportEligibility` — the canonical selected-run fetch.
 *
 * `run-detail-view.test.tsx` mocks this hook so it can hand the view a real
 * frozen projection, which means nothing there exercises the hook's own body.
 * These specs do, and they are about the two things that are easy to get
 * backwards:
 *
 *   - it must SKIP the query when there is no run to ask about, rather than
 *     subscribing with an undefined id;
 *   - a run that carries no eligibility and a run that has not loaded yet must
 *     both surface as `undefined`, because every caller renders nothing for
 *     both — but only one of them is still `isLoading`.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const useQueryMock = vi.hoisted(() => vi.fn());

vi.mock("convex/react", () => ({ useQuery: useQueryMock }));

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

describe("useRunImportEligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries the canonical single-run projection for the given run", () => {
    useQueryMock.mockReturnValue({ importEligibility: ELIGIBILITY });
    const { result } = renderHook(() => useRunImportEligibility("run-1"));
    // The run's OWN query, not the run-list projection — that one carries no
    // eligibility, so reading it would render every converted run as native.
    expect(useQueryMock).toHaveBeenCalledWith("testSuites:getTestSuiteRun", {
      runId: "run-1",
    });
    expect(result.current.eligibility).toEqual(ELIGIBILITY);
    expect(result.current.isLoading).toBe(false);
  });

  it.each([
    ["no run id", undefined],
    ["a null run id", null],
  ] as const)("skips the query given %s", (_label, runId) => {
    useQueryMock.mockReturnValue(undefined);
    const { result } = renderHook(() => useRunImportEligibility(runId));
    // Subscribing with an undefined id would ask the backend a question with
    // no subject; "skip" is Convex's way of not asking.
    expect(useQueryMock).toHaveBeenCalledWith(
      "testSuites:getTestSuiteRun",
      "skip",
    );
    expect(result.current.eligibility).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it("skips the query when explicitly disabled", () => {
    useQueryMock.mockReturnValue(undefined);
    const { result } = renderHook(() =>
      useRunImportEligibility("run-1", { enabled: false }),
    );
    expect(useQueryMock).toHaveBeenCalledWith(
      "testSuites:getTestSuiteRun",
      "skip",
    );
    expect(result.current.isLoading).toBe(false);
  });

  it("reports a pending query as loading with no eligibility", () => {
    useQueryMock.mockReturnValue(undefined);
    const { result } = renderHook(() => useRunImportEligibility("run-1"));
    expect(result.current.eligibility).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });

  it.each([
    ["a run that reports no eligibility", {}],
    ["a run the query could not find", null],
  ] as const)("settles %s as absent, not loading", (_label, run) => {
    useQueryMock.mockReturnValue(run);
    const { result } = renderHook(() => useRunImportEligibility("run-1"));
    // Absent-and-settled is a different fact from still-loading: it says this
    // deployment has no opinion, which callers render as nothing rather than
    // as "no imported cases".
    expect(result.current.eligibility).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });
});
