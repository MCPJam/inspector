import {
  AlertTriangle,
  Clock,
  LogIn,
  RefreshCw,
  Target,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { useIsMemberActor } from "@/hooks/use-is-member-actor";
import { cn } from "@/lib/utils";
import type {
  AnalysisStatus,
  AnalysisStatusKind,
} from "@/components/shared/usage-insights/analysis-status";

const ICONS: Record<AnalysisStatusKind, LucideIcon> = {
  empty: Target,
  guest: LogIn,
  deferred: Clock,
  analyzing: RefreshCw,
  waiting: Clock,
  failed: AlertTriangle,
  grouping: RefreshCw,
};

/**
 * One empty insights view, saying why it is empty (see `analysisStatus`).
 *
 * The Analyze now button renders only when the status offers it, the caller
 * can act on it (a swarm passes no handler), and the reader is a member: the
 * mutation refuses a guest outright, so a guest gets the sentence alone.
 */
export function AnalysisStatusPanel({
  status,
  onAnalyzeNow,
  busy = false,
  className,
  testId = "analysis-status",
}: {
  status: AnalysisStatus;
  onAnalyzeNow?: () => void;
  busy?: boolean;
  className?: string;
  testId?: string;
}) {
  const Icon = ICONS[status.kind];
  const spinning = status.kind === "analyzing" || status.kind === "grouping";
  return (
    <div
      role="status"
      data-testid={testId}
      data-status={status.kind}
      className={cn("flex flex-col items-center gap-2 text-center", className)}
    >
      <Icon
        aria-hidden
        className={cn(
          "h-6 w-6 text-muted-foreground/60",
          spinning && "animate-spin",
        )}
      />
      <p className="text-sm font-medium">{status.title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{status.body}</p>
      {status.action === "analyze_now" && onAnalyzeNow ? (
        <AnalyzeNowForMembers onAnalyzeNow={onAnalyzeNow} busy={busy} />
      ) : null}
    </div>
  );
}

/**
 * Mounted only when the button would show, so the member check (a Convex
 * query) runs only where it can change what renders.
 */
function AnalyzeNowForMembers({
  onAnalyzeNow,
  busy,
}: {
  onAnalyzeNow: () => void;
  busy: boolean;
}) {
  if (useIsMemberActor() !== true) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 rounded-md px-2.5 text-[11px]"
      disabled={busy}
      // Never wired straight to onClick: React would hand the handler a
      // synthetic event, and the rebuild path serializes its argument.
      onClick={() => onAnalyzeNow()}
    >
      <RefreshCw
        aria-hidden
        className={cn("mr-1.5 h-3 w-3", busy && "animate-spin")}
      />
      {busy ? "Starting…" : "Analyze now"}
    </Button>
  );
}
