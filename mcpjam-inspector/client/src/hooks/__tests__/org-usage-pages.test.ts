import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { mergeOrgUsagePages, useOrgUsagePages } from "../org-usage-pages";
import type { OrgModelUsageSummary } from "../use-org-model-config";

const query = vi.hoisted(() => ({ usePaginatedQuery: vi.fn(), loadMore: vi.fn() }));
vi.mock("convex/react", () => ({ usePaginatedQuery: query.usePaginatedQuery }));

function page(count: number): OrgModelUsageSummary {
  const total = {
    key: "total",
    requestCount: count,
    inputTokens: count,
    outputTokens: 2 * count,
    totalTokens: 3 * count,
    knownCostUsd: count / 100,
    knownCostRequests: count,
    unknownCostRequests: 0,
  };
  return {
    startAt: 0,
    endAt: 1,
    rangeDays: 366,
    total,
    byDate: [{ ...total, key: "2026-10-01" }],
    byProvider: [],
    byModel: [],
    byModelEffort: [],
    byProject: [],
    byUser: [],
    recentRecords: [],
  };
}

describe("paged usage totals", () => {
  it("retains exact totals and groups across a large reporting window", () => {
    const result = mergeOrgUsagePages(
      Array.from({ length: 100 }, () => page(100)),
    );
    expect(result?.total).toMatchObject({
      requestCount: 10000,
      totalTokens: 30000,
      knownCostUsd: 100,
    });
    expect(result?.byDate[0].requestCount).toBe(10000);
  });
  it("keeps absence distinct from zero spend", () => {
    expect(mergeOrgUsagePages([])).toBeUndefined();
    expect(mergeOrgUsagePages([page(0)])?.total.requestCount).toBe(0);
  });
});

describe("usage reporting window refresh", () => {
  const openedAt = Date.UTC(2026, 9, 13);
  type Source = "byok" | "local_byok";
  let status: Record<Source, "Exhausted" | "CanLoadMore">;
  let records: { at: number; source: Source }[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(openedAt);
    status = { byok: "Exhausted", local_byok: "Exhausted" };
    records = [{ at: openedAt - 1, source: "byok" }];
    query.loadMore.mockReset();
    query.usePaginatedQuery
      .mockReset()
      .mockImplementation(
        (
          _reference: unknown,
          args:
            { startAt: number; endAt: number; modelSource: Source } | "skip",
        ) => ({
          results:
            args === "skip"
              ? []
              : [
                  page(
                    records.filter(
                      ({ at, source }) =>
                        source === args.modelSource &&
                        at >= args.startAt &&
                        at <= args.endAt,
                    ).length,
                  ),
                ],
          status:
            args === "skip" ? "LoadingFirstPage" : status[args.modelSource],
          loadMore: query.loadMore,
        }),
      );
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const latestArgs = () => query.usePaginatedQuery.mock.lastCall?.[1];

  it("pages each BYOK source separately and merges both", () => {
    records.push({ at: openedAt - 2, source: "local_byok" });
    const { result } = renderHook(() => useOrgUsagePages("org", true, 30));
    const sources = query.usePaginatedQuery.mock.calls.map(
      ([, args]) => args.modelSource,
    );
    expect(sources).toEqual(expect.arrayContaining(["byok", "local_byok"]));
    expect(result.current.summary?.total.requestCount).toBe(2);
  });

  it("includes records created after opening on the next minute", () => {
    const { result } = renderHook(() => useOrgUsagePages("org", true, 30));
    expect(result.current.summary?.total.requestCount).toBe(1);
    records.push({ at: openedAt + 10_000, source: "local_byok" });
    act(() => vi.advanceTimersByTime(60_000));
    expect(latestArgs()).toMatchObject({ endAt: openedAt + 60_000 });
    expect(result.current.summary?.total.requestCount).toBe(2);
  });

  it("keeps pagination on one window until all pages finish", () => {
    status.local_byok = "CanLoadMore";
    const { result, rerender } = renderHook(() =>
      useOrgUsagePages("org", true, 30),
    );
    expect(query.loadMore).toHaveBeenCalledWith(100);
    act(() => vi.advanceTimersByTime(120_000));
    expect(latestArgs()).toMatchObject({ endAt: openedAt });
    expect(result.current.summary).toBeUndefined();
    status.local_byok = "Exhausted";
    rerender();
    act(() => vi.advanceTimersByTime(60_000));
    expect(latestArgs()).toMatchObject({ endAt: openedAt + 180_000 });
  });

  it("refreshes on focus and when the tab becomes visible", () => {
    renderHook(() => useOrgUsagePages("org", true, 30));
    vi.setSystemTime(openedAt + 10_000);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(latestArgs()).toMatchObject({ endAt: openedAt + 10_000 });
    vi.setSystemTime(openedAt + 20_000);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(latestArgs()).toMatchObject({ endAt: openedAt + 20_000 });
  });

  it("skips hidden tabs and cancels refresh work when disabled or unmounted", () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useOrgUsagePages("org", enabled, 30),
      {
        initialProps: { enabled: true },
      },
    );
    act(() => vi.advanceTimersByTime(60_000));
    expect(latestArgs()).toMatchObject({ endAt: openedAt });
    visibility.mockReturnValue("visible");
    rerender({ enabled: false });
    expect(latestArgs()).toBe("skip");
    expect(vi.getTimerCount()).toBe(0);
    rerender({ enabled: true });
    expect(latestArgs()).toMatchObject({ endAt: openedAt + 60_000 });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
