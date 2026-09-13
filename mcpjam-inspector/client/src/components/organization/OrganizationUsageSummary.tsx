import { useQuery } from "convex/react";
import {
  FlaskConical,
  FolderOpen,
  MessageSquare,
  Server,
  Users,
  Zap,
} from "lucide-react";
import { Skeleton } from "@mcpjam/design-system/skeleton";

type OrgMetric = { value: number | null; windowDays: number } | undefined;

export function OrganizationUsageSummary({
  organizationId,
}: {
  organizationId: string;
}) {
  const data = useQuery("home:getOrgHomeData" as any, { organizationId }) as
    | {
        memberCount: number;
        projects: unknown[];
        totalServerCount: number;
        evalSuiteCount: number;
      }
    | undefined;
  const executions = useQuery("orgMetrics:getOrgMetric" as any, {
    organizationId,
    metric: "tool_executions_30d",
  }) as OrgMetric;
  const messages = useQuery("orgMetrics:getOrgMetric" as any, {
    organizationId,
    metric: "messages_sent_30d",
  }) as OrgMetric;
  const stats = [
    {
      label: "Tool executions",
      value: executions?.value,
      icon: Zap,
      period: `Last ${executions?.windowDays ?? 30} days`,
    },
    {
      label: "Messages sent",
      value: messages?.value,
      icon: MessageSquare,
      period: `Last ${messages?.windowDays ?? 30} days`,
    },
    { label: "Teammates", value: data?.memberCount, icon: Users },
    { label: "Projects", value: data?.projects?.length, icon: FolderOpen },
    { label: "Servers", value: data?.totalServerCount, icon: Server },
    { label: "Eval suites", value: data?.evalSuiteCount, icon: FlaskConical },
  ];

  return (
    <section
      aria-labelledby="organization-usage-heading"
      className="space-y-4 border-t border-border pt-7"
    >
      <div className="space-y-1">
        <h2 id="organization-usage-heading" className="text-sm font-semibold">
          Your organization at a glance
        </h2>
        <p className="text-xs text-foreground/80">
          Activity and resources across your organization.
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        {stats.map(({ label, value, icon: Icon, period }) => (
          <div key={label} className={period ? "col-span-1 sm:col-span-2" : ""}>
            <dt className="flex items-center gap-1.5 text-xs text-foreground/80">
              <Icon aria-hidden="true" className="size-3.5" />
              {label}
            </dt>
            <dd className="mt-2">
              {value == null ? (
                <>
                  <Skeleton className="h-8 w-20" />
                  <span className="sr-only">Loading {label.toLowerCase()}</span>
                </>
              ) : (
                <span
                  className={
                    period
                      ? "text-3xl font-semibold tracking-tight tabular-nums"
                      : "text-xl font-semibold tabular-nums"
                  }
                >
                  {value.toLocaleString()}
                </span>
              )}
              {period && (
                <span className="mt-1 block text-xs text-foreground/80">
                  {period}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
