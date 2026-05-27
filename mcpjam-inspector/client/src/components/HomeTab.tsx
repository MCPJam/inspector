import { useEffect, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { useAppNavigate } from "@/lib/app-navigation";
import { Button } from "@mcpjam/design-system/button";
import { OrgStatsStrip } from "./home/OrgStatsStrip";
import { RecommendedServers } from "./home/RecommendedServers";
import { RecommendedClients } from "./home/RecommendedClients";
import { ProductUpdatesFeed } from "./home/ProductUpdatesFeed";

interface HomeTabProps {
  organizationId: string | null;
  projectId: string | null;
}

function getGreeting(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function deriveFirstName(opts: {
  workosFirst: string | null | undefined;
  fullName: string;
  email: string | null | undefined;
}): string {
  if (opts.workosFirst && opts.workosFirst.trim()) return opts.workosFirst.trim();
  const fromFull = opts.fullName.split(" ")[0]?.trim();
  if (fromFull && fromFull.length > 1) return fromFull;
  const fromEmail = opts.email?.split("@")[0]?.trim();
  if (fromEmail) return fromEmail;
  return "there";
}

export function HomeTab({ organizationId, projectId }: HomeTabProps) {
  const navigate = useAppNavigate();
  const { user } = useAuth();
  const convexUser = useQuery("users:getCurrentUser" as any) as
    | { name?: string }
    | undefined;

  const data = useQuery(
    "home:getOrgHomeData" as any,
    organizationId ? ({ organizationId } as any) : "skip"
  ) as
    | {
        memberCount: number;
        projects: { _id: string; name: string; icon?: string }[];
        totalServerCount: number;
        evalSuiteCount: number;
        recommendedServers: {
          name: string;
          url: string;
          description: string;
          category: string;
        }[];
        members: { _id: string; name: string; imageUrl: string | null; email: string }[];
      }
    | undefined;

  type OrgMetricResult =
    | { value: number; refreshedAt: number | null; windowDays: number }
    | undefined;

  const toolExecutionCount = useQuery(
    "orgMetrics:getOrgMetric" as any,
    organizationId
      ? ({ organizationId, metric: "tool_executions_30d" } as any)
      : "skip"
  ) as OrgMetricResult;

  const messagesSentCount = useQuery(
    "orgMetrics:getOrgMetric" as any,
    organizationId
      ? ({ organizationId, metric: "messages_sent_30d" } as any)
      : "skip"
  ) as OrgMetricResult;

  const ensureMetricFresh = useMutation(
    "orgMetrics:ensureOrgMetricFresh" as any
  );
  useEffect(() => {
    if (!organizationId) return;
    const args = { organizationId } as { organizationId: string };
    Promise.all([
      ensureMetricFresh({ ...args, metric: "tool_executions_30d" } as any),
      ensureMetricFresh({ ...args, metric: "messages_sent_30d" } as any),
    ]).catch(() => {
      // Soft-fail: cache stays stale, UI shows last known value (or 0).
    });
  }, [organizationId, ensureMetricFresh]);

  const fullName =
    convexUser?.name ||
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    "";
  const firstName = deriveFirstName({
    workosFirst: user?.firstName,
    fullName,
    email: user?.email,
  });
  const greeting = useMemo(() => getGreeting(new Date()), []);
  const dateLabel = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    []
  );

  if (!organizationId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-[#FAFAF7] p-8 text-center dark:bg-neutral-950">
        <p className="text-lg font-medium">Welcome to MCPJam</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Join or create an organization to see your team&apos;s activity, connected
          servers, and projects in one place.
        </p>
        <Button onClick={() => navigate("/organizations")}>Get started</Button>
      </div>
    );
  }

  const isLoading = data === undefined;

  return (
    <div className="relative h-full overflow-y-auto bg-[#FAFAF7] dark:bg-neutral-950">
      {/* Atmospheric backdrop — soft warm blooms anchored to the top */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] overflow-hidden"
      >
        <div className="absolute -left-40 -top-48 h-[640px] w-[640px] rounded-full bg-gradient-to-br from-amber-100/60 via-orange-50/40 to-transparent blur-3xl dark:from-amber-500/[0.06] dark:via-orange-500/[0.04]" />
        <div className="absolute -right-44 top-10 h-[520px] w-[520px] rounded-full bg-gradient-to-bl from-rose-100/50 via-rose-50/20 to-transparent blur-3xl dark:from-rose-500/[0.05]" />
        <div className="absolute right-1/3 -top-32 h-[360px] w-[360px] rounded-full bg-gradient-to-b from-stone-100/60 to-transparent blur-3xl dark:from-stone-500/[0.04]" />
      </div>

      <div className="relative mx-auto flex max-w-6xl flex-col gap-7 px-8 pb-20 pt-12">
        {/* Greeting */}
        <header className="flex flex-col gap-1.5">
          <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-foreground/55">
            {dateLabel}
          </p>
          <h1 className="text-[40px] font-semibold leading-[1.05] tracking-[-0.025em] text-foreground sm:text-[44px]">
            {greeting},{" "}
            <span className="text-foreground/70">{firstName}</span>
          </h1>
        </header>

        {/* Slim stats — pills with dot separators */}
        <OrgStatsStrip
          memberCount={isLoading ? null : data!.memberCount}
          projectCount={isLoading ? null : data!.projects.length}
          totalServerCount={isLoading ? null : data!.totalServerCount}
          evalSuiteCount={isLoading ? null : data!.evalSuiteCount}
          toolExecutionCount={toolExecutionCount?.value ?? null}
          toolExecutionWindowDays={toolExecutionCount?.windowDays ?? 30}
          messagesSentCount={messagesSentCount?.value ?? null}
          messagesSentWindowDays={messagesSentCount?.windowDays ?? 30}
        />

        {/* Hero card */}
        <RecommendedServers
          servers={isLoading ? [] : data!.recommendedServers}
          projectId={projectId}
        />

        {/* Secondary cards */}
        <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          <RecommendedClients projectId={projectId} />
          <ProductUpdatesFeed />
        </div>
      </div>
    </div>
  );
}
