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
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-background p-8 text-center">
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
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-8 pb-20 pt-14">
        {/* Greeting */}
        <header className="flex flex-col gap-2">
          <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {dateLabel}
          </p>
          <h1 className="text-[36px] font-semibold leading-[1.1] tracking-[-0.03em] text-foreground sm:text-[40px]">
            {greeting},{" "}
            <span className="font-semibold text-muted-foreground">
              {firstName}
            </span>
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
