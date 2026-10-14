import { useEffect, useMemo, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { makeFunctionReference, type PaginationOptions } from "convex/server";
import type {
  OrgModelUsageAggregate,
  OrgModelUsageSummary,
} from "./use-org-model-config";

function add<T extends OrgModelUsageAggregate>(a: T, b: T): T {
  return {
    ...a,
    requestCount: a.requestCount + b.requestCount,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
    knownCostUsd: a.knownCostUsd + b.knownCostUsd,
    knownCostRequests: a.knownCostRequests + b.knownCostRequests,
    unknownCostRequests: a.unknownCostRequests + b.unknownCostRequests,
  };
}

function groups<T extends OrgModelUsageAggregate>(pages: T[][]): T[] {
  const merged = new Map<string, T>();
  for (const row of pages.flat()) {
    const existing = merged.get(row.key);
    merged.set(row.key, existing ? add(existing, row) : { ...row });
  }
  return [...merged.values()].sort(
    (a, b) => b.requestCount - a.requestCount || a.key.localeCompare(b.key),
  );
}

/** Fold summary pages, never a truncated scan presented as a complete total. */
export function mergeOrgUsagePages(
  pages: OrgModelUsageSummary[],
): OrgModelUsageSummary | undefined {
  if (!pages.length) return undefined;
  const first = pages[0];
  const recent = new Map(
    pages.flatMap((p) => p.recentRecords).map((r) => [r.id, r]),
  );
  return {
    ...first,
    total: pages
      .slice(1)
      .reduce((total, p) => add(total, p.total), first.total),
    byDate: groups(pages.map((p) => p.byDate)).sort((a, b) =>
      a.key.localeCompare(b.key),
    ),
    byProvider: groups(pages.map((p) => p.byProvider)),
    byModel: groups(pages.map((p) => p.byModel)),
    byModelEffort: pages.some((p) => p.byModelEffort !== undefined)
      ? groups(pages.map((p) => p.byModelEffort ?? [])) : undefined,
    byProject: groups(pages.map((p) => p.byProject)),
    byUser: groups(pages.map((p) => p.byUser)),
    recentRecords: [...recent.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20),
  };
}

type PageArgs = {
  organizationId: string;
  startAt: number;
  endAt: number;
  rangeDays: number;
  modelSource: UsageSource;
  paginationOpts: PaginationOptions;
};
type UsageSource = "byok" | "local_byok";
type ReportingWindow = Pick<PageArgs, "startAt" | "endAt" | "rangeDays">;
const usagePage = makeFunctionReference<
  "query",
  PageArgs,
  { page: OrgModelUsageSummary[]; isDone: boolean; continueCursor: string }
>("organizationUsagePages:page");

/** One source per pagination, so each page reads only its own BYOK index. */
function useSourcePages(
  organizationId: string | null,
  enabled: boolean,
  reportingWindow: ReportingWindow,
  modelSource: UsageSource,
) {
  const { results, status, loadMore } = usePaginatedQuery(
    usagePage,
    organizationId && enabled
      ? { organizationId, ...reportingWindow, modelSource }
      : "skip",
    { initialNumItems: 100 },
  );
  useEffect(() => {
    if (organizationId && enabled && status === "CanLoadMore") loadMore(100);
  }, [organizationId, enabled, status, loadMore]);
  return { results, exhausted: status === "Exhausted" };
}

export function useOrgUsagePages(
  organizationId: string | null,
  enabled: boolean,
  rangeDays: number,
) {
  const [refreshedAt, setRefreshedAt] = useState(0);
  const reportingWindow = useMemo(() => {
    const endAt = Date.now();
    const days = Math.min(366, Math.max(1, Math.floor(rangeDays)));
    return { endAt, startAt: endAt - days * 86_400_000, rangeDays: days };
  }, [organizationId, enabled, rangeDays, refreshedAt]);
  const cloud = useSourcePages(
    organizationId,
    enabled,
    reportingWindow,
    "byok",
  );
  const local = useSourcePages(
    organizationId,
    enabled,
    reportingWindow,
    "local_byok",
  );
  const exhausted = cloud.exhausted && local.exhausted;
  useEffect(() => {
    // Keep cursors on one snapshot until pagination completes.
    if (!organizationId || !enabled || !exhausted) return;
    const refresh = () => {
      if (document.visibilityState === "visible") setRefreshedAt(Date.now());
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [organizationId, enabled, exhausted]);
  const summary = useMemo(
    () =>
      exhausted
        ? mergeOrgUsagePages([...cloud.results, ...local.results])
        : undefined,
    [cloud.results, local.results, exhausted],
  );
  return {
    summary,
    isLoading: !!organizationId && enabled && !exhausted,
  };
}
