import { describe, expect, it } from "vitest";
import { mergeOrgUsagePages } from "../org-usage-pages";
import type { OrgModelUsageSummary } from "../use-org-model-config";

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
