import { useQuery } from "convex/react";
import { useAppNavigate } from "@/lib/app-navigation";
import { Button } from "@mcpjam/design-system/button";
import { OrgStatsStrip } from "./home/OrgStatsStrip";
import { OrgActivityFeed } from "./home/OrgActivityFeed";
import { ProductUpdatesFeed } from "./home/ProductUpdatesFeed";

interface HomeTabProps {
  organizationId: string | null;
}

export function HomeTab({ organizationId }: HomeTabProps) {
  const navigate = useAppNavigate();

  const data = useQuery(
    "home:getOrgHomeData" as any,
    organizationId ? ({ organizationId } as any) : "skip"
  ) as
    | {
        memberCount: number;
        projects: { _id: string; name: string; icon?: string }[];
        totalServerCount: number;
        evalSuiteCount: number;
        recentActivity: {
          action: string;
          actorEmail: string | null;
          timestamp: number;
          targetType: string;
        }[];
        members: { _id: string; name: string; imageUrl: string | null; email: string }[];
      }
    | undefined;

  if (!organizationId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-lg font-medium">Welcome to MCPJam</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Join or create an organization to see your team&apos;s activity, connected servers, and
          projects in one place.
        </p>
        <Button onClick={() => navigate("/organizations")}>
          Get started
        </Button>
      </div>
    );
  }

  const isLoading = data === undefined;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <OrgStatsStrip
        memberCount={isLoading ? 0 : data.memberCount}
        projectCount={isLoading ? 0 : data.projects.length}
        totalServerCount={isLoading ? 0 : data.totalServerCount}
        evalSuiteCount={isLoading ? 0 : data.evalSuiteCount}
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <OrgActivityFeed events={isLoading ? [] : data.recentActivity} />
        <ProductUpdatesFeed />
      </div>
    </div>
  );
}
