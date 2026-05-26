import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface SidebarTrialCountdownProps {
  trialEndsAt: number;
  trialStartedAt: number | null;
  onUpgradeClick?: () => void;
  className?: string;
}

export function SidebarTrialCountdown({
  trialEndsAt,
  trialStartedAt,
  onUpgradeClick,
  className,
}: SidebarTrialCountdownProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const remaining = trialEndsAt - now;
    if (remaining <= 0) return;

    const delay = remaining < 60 * 60 * 1000 ? 1_000 : 60_000;
    const id = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(id);
  }, [now, trialEndsAt]);

  const remainingMs = Math.max(0, trialEndsAt - now);
  const totalMs =
    trialStartedAt && trialEndsAt > trialStartedAt
      ? trialEndsAt - trialStartedAt
      : remainingMs || 1;
  const elapsedPct = Math.min(
    100,
    Math.max(0, ((totalMs - remainingMs) / totalMs) * 100),
  );

  const Wrapper: "button" | "div" = onUpgradeClick ? "button" : "div";

  return (
    <div
      data-testid="sidebar-trial-countdown"
      aria-label="Trial countdown"
      className={cn("group-data-[collapsible=icon]:hidden", className)}
    >
      <Wrapper
        {...(onUpgradeClick
          ? {
              type: "button" as const,
              onClick: onUpgradeClick,
              "aria-label": "Trial — upgrade",
            }
          : {})}
        className={cn(
          "flex w-full flex-col gap-1 rounded-md px-2 py-1 text-left",
          onUpgradeClick &&
            "transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <div className="flex items-baseline justify-between gap-2 leading-none">
          <span className="text-[11px] text-foreground">Trial</span>
          <span className="shrink-0 text-[11px] text-foreground">
            {formatRemaining(remainingMs)}
          </span>
        </div>
        <div className="relative h-[3px] w-full overflow-hidden rounded-full bg-primary/15">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary/80 to-primary transition-[width] duration-500"
            style={{ width: `${elapsedPct}%` }}
          />
        </div>
      </Wrapper>
    </div>
  );
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3_600);
  const minutes = Math.floor((totalSec % 3_600) / 60);
  const seconds = totalSec % 60;

  if (days >= 1) return `${days}d ${hours}h ${minutes}m`;
  if (hours >= 1) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes >= 1) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
