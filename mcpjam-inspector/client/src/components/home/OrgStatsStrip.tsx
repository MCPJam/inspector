import { Users, FolderOpen, Plug, FlaskConical } from "lucide-react";
import { Card, CardContent } from "@mcpjam/design-system/card";
import { useAppNavigate } from "@/lib/app-navigation";

interface OrgStatsStripProps {
  memberCount: number;
  projectCount: number;
  totalServerCount: number;
  evalSuiteCount: number;
}

interface StatCardProps {
  icon: React.ComponentType<{ className?: string }>;
  value: number;
  label: string;
  secondary: string;
  onClick?: () => void;
}

function StatCard({ icon: Icon, value, label, secondary, onClick }: StatCardProps) {
  return (
    <Card
      className={onClick ? "cursor-pointer transition-colors hover:bg-muted/50" : undefined}
      onClick={onClick}
    >
      <CardContent className="flex flex-col gap-2 p-5">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <div>
          <p className="text-3xl font-bold tracking-tight">{value}</p>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{secondary}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function OrgStatsStrip({
  memberCount,
  projectCount,
  totalServerCount,
  evalSuiteCount,
}: OrgStatsStripProps) {
  const navigate = useAppNavigate();

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        icon={Users}
        value={memberCount}
        label="teammates"
        secondary="in your organization"
      />
      <StatCard
        icon={FolderOpen}
        value={projectCount}
        label="projects"
        secondary="organizing your work"
        onClick={() => navigate("/servers")}
      />
      <StatCard
        icon={Plug}
        value={totalServerCount}
        label="MCP servers"
        secondary="connected across all projects"
        onClick={() => navigate("/servers")}
      />
      <StatCard
        icon={FlaskConical}
        value={evalSuiteCount}
        label="eval suites"
        secondary={
          evalSuiteCount === 0
            ? "Start testing your tools →"
            : "keeping tools reliable"
        }
        onClick={evalSuiteCount === 0 ? () => navigate("/evals") : undefined}
      />
    </div>
  );
}
