import type { KeyboardEvent } from "react";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import type { HostFocusTabId } from "../types";
import { HOST_FOCUS_TAB_DEFS } from "./host-focus-tab-defs";

export type HostFocusIssuesByTab = Record<HostFocusTabId, number>;

interface HostFocusTabBarProps {
  tab: HostFocusTabId;
  onTabChange: (next: HostFocusTabId) => void;
  issuesByTab: HostFocusIssuesByTab;
  className?: string;
}

const tabBtnClass = cn(
  "relative pb-2.5 pt-1",
  "motion-safe:transition-[color,transform] motion-safe:duration-150",
  "flex shrink-0 items-center gap-2 rounded-md px-3 text-left text-[12.5px] font-medium",
  "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
  "motion-safe:active:scale-[0.98]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
);

export function HostFocusTabBar({
  tab,
  onTabChange,
  issuesByTab,
  className,
}: HostFocusTabBarProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const idx = HOST_FOCUS_TAB_DEFS.findIndex((t) => t.id === tab);
    if (idx === -1) return;
    const next =
      event.key === "ArrowRight"
        ? HOST_FOCUS_TAB_DEFS[(idx + 1) % HOST_FOCUS_TAB_DEFS.length]
        : HOST_FOCUS_TAB_DEFS[
            (idx - 1 + HOST_FOCUS_TAB_DEFS.length) %
              HOST_FOCUS_TAB_DEFS.length
          ];
    onTabChange(next.id);
  };

  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-h-[44px] min-w-0 flex-1 flex-nowrap items-center gap-0.5 overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {HOST_FOCUS_TAB_DEFS.map((t) => {
        const active = tab === t.id;
        const count = issuesByTab[t.id];
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onTabChange(t.id)}
            className={cn(tabBtnClass, active && "text-foreground")}
          >
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground",
                active &&
                  "border-primary/30 bg-primary/10 text-primary",
              )}
              aria-hidden
            >
              {t.icon}
            </span>
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span>{t.label}</span>
              {count > 0 ? (
                <Badge
                  variant="outline"
                  className="h-4 border-amber-500/40 bg-amber-500/10 px-1 text-[9.5px] text-amber-800 dark:text-amber-200"
                >
                  {count}
                </Badge>
              ) : null}
            </span>
            {active ? (
              <span
                className="pointer-events-none absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-primary shadow-[0_0_10px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
                aria-hidden
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
