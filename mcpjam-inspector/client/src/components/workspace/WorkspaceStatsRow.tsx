import { useQuery } from "convex/react";
import { Server, Users, MessageSquare } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface WorkspaceStatsRowProps {
  convexWorkspaceId: string | null;
  localServerCount: number;
}

export function WorkspaceStatsRow({
  convexWorkspaceId,
  localServerCount,
}: WorkspaceStatsRowProps) {
  const stats = useQuery(
    "workspaces:getWorkspaceStats" as any,
    convexWorkspaceId ? { workspaceId: convexWorkspaceId } : "skip",
  );

  const isLoading = convexWorkspaceId && stats === undefined;

  if (isLoading) {
    return (
      <div className="flex gap-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[72px] flex-1 rounded-lg" />
        ))}
      </div>
    );
  }

  const serverCount = stats?.serverCount ?? localServerCount;
  const memberCount = stats?.memberCount ?? null;
  const sessionCount = stats
    ? stats.chatSessionCapped
      ? "10,000+"
      : stats.chatSessionCount.toLocaleString()
    : null;
  const totalMessages = stats?.totalMessages ?? null;

  return (
    <div className="flex gap-4">
      <StatCard
        icon={<Server className="h-4 w-4 text-muted-foreground" />}
        count={serverCount.toLocaleString()}
        label="Servers"
      />
      <StatCard
        icon={<Users className="h-4 w-4 text-muted-foreground" />}
        count={memberCount !== null ? memberCount.toLocaleString() : "—"}
        label="Members"
      />
      <StatCard
        icon={<MessageSquare className="h-4 w-4 text-muted-foreground" />}
        count={sessionCount ?? "—"}
        label="Sessions"
        subtitle={
          totalMessages !== null
            ? `${totalMessages.toLocaleString()} messages`
            : undefined
        }
      />
    </div>
  );
}

function StatCard({
  icon,
  count,
  label,
  subtitle,
}: {
  icon: React.ReactNode;
  count: string;
  label: string;
  subtitle?: string;
}) {
  return (
    <div className="rounded-lg border border-border/40 bg-muted/30 px-4 py-3 flex-1">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-2xl font-semibold">{count}</span>
      </div>
      <p className="text-xs text-muted-foreground">{label}</p>
      {subtitle && (
        <p className="text-xs text-muted-foreground/70 mt-0.5">{subtitle}</p>
      )}
    </div>
  );
}
