import {
  Users,
  FolderOpen,
  Server,
  FlaskConical,
  Zap,
  MessageSquare,
} from "lucide-react";
import { useAppNavigate } from "@/lib/app-navigation";

interface OrgStatsStripProps {
  memberCount: number | null;
  projectCount: number | null;
  totalServerCount: number | null;
  evalSuiteCount: number | null;
  toolExecutionCount: number | null;
  toolExecutionWindowDays: number;
  messagesSentCount: number | null;
  messagesSentWindowDays: number;
}

interface StatProps {
  icon: React.ComponentType<{ className?: string }>;
  value: number | null;
  label: string;
  onClick?: () => void;
  title?: string;
}

function formatCompact(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

function Stat({ icon: Icon, value, label, onClick, title }: StatProps) {
  const body = (
    <span className="inline-flex items-center gap-1">
      <Icon className="size-3 text-muted-foreground/70" />
      {value === null ? (
        <span className="inline-block h-3 w-4 animate-pulse rounded-sm bg-muted align-middle" />
      ) : (
        <span className="tabular-nums text-foreground/80">{formatCompact(value)}</span>
      )}
      <span>{label}</span>
    </span>
  );

  const base = "rounded-sm px-1 py-0.5 transition-colors";
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`${base} -mx-0.5 hover:text-foreground`}
    >
      {body}
    </button>
  ) : (
    <span className={base} title={title}>
      {body}
    </span>
  );
}

function Sep() {
  return (
    <span aria-hidden className="select-none text-border">
      ·
    </span>
  );
}

export function OrgStatsStrip({
  memberCount,
  projectCount,
  totalServerCount,
  evalSuiteCount,
  toolExecutionCount,
  toolExecutionWindowDays,
  messagesSentCount,
  messagesSentWindowDays,
}: OrgStatsStripProps) {
  const navigate = useAppNavigate();

  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 text-xs text-muted-foreground">
      <Stat
        icon={Users}
        value={memberCount}
        label={memberCount === 1 ? "teammate" : "teammates"}
      />
      <Sep />
      <Stat
        icon={FolderOpen}
        value={projectCount}
        label={projectCount === 1 ? "project" : "projects"}
        onClick={() => navigate("/servers")}
      />
      <Sep />
      <Stat
        icon={Server}
        value={totalServerCount}
        label={totalServerCount === 1 ? "server" : "servers"}
        onClick={() => navigate("/servers")}
      />
      <Sep />
      <Stat
        icon={FlaskConical}
        value={evalSuiteCount}
        label={evalSuiteCount === 1 ? "eval suite" : "eval suites"}
        onClick={() => navigate("/evals")}
      />
      <Sep />
      <Stat
        icon={Zap}
        value={toolExecutionCount}
        label={`tool exec · ${toolExecutionWindowDays}d`}
        title={`Tool executions in the last ${toolExecutionWindowDays} days`}
      />
      <Sep />
      <Stat
        icon={MessageSquare}
        value={messagesSentCount}
        label={`messages · ${messagesSentWindowDays}d`}
        title={`Messages sent in the last ${messagesSentWindowDays} days`}
      />
    </div>
  );
}
