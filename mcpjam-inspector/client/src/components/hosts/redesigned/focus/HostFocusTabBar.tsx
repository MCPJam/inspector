import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import type { HostFocusTabId } from "../types";
import { HOST_FOCUS_TAB_DEFS } from "./host-focus-tab-defs";

interface HostFocusTabBarProps {
  tab: HostFocusTabId;
  onTabChange: (next: HostFocusTabId) => void;
  className?: string;
}

const tabBtnClass = cn(
  "relative pb-2.5 pt-1",
  "motion-safe:transition-colors motion-safe:duration-150",
  "flex shrink-0 items-center gap-1.5 px-2 text-left text-[12.5px] font-medium",
  "text-muted-foreground hover:text-foreground",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
);

export function HostFocusTabBar({
  tab,
  onTabChange,
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
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onTabChange(t.id)}
            className={cn(tabBtnClass, active && "text-foreground")}
          >
            <span className="whitespace-nowrap">{t.label}</span>
            {active ? (
              <span
                className="pointer-events-none absolute bottom-0 left-1 right-1 h-[2px] rounded-full bg-primary"
                aria-hidden
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
