import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface FocusTabDef<TTabId extends string> {
  id: TTabId;
  label: string;
}

export interface FocusTabBarProps<TTabId extends string> {
  tab: TTabId;
  onTabChange: (next: TTabId) => void;
  /** The tabs to render, in order. */
  tabs: ReadonlyArray<FocusTabDef<TTabId>>;
  className?: string;
}

const tabBtnClass = cn(
  "relative pb-2.5 pt-1",
  "motion-safe:transition-colors motion-safe:duration-150",
  "flex shrink-0 items-center gap-1.5 px-2 text-left text-[12.5px] font-medium",
  "text-muted-foreground hover:text-foreground",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
);

/**
 * The underlined tab row of a focus panel. Left and right arrow keys move to
 * the neighbouring tab and wrap at either end.
 */
export function FocusTabBar<TTabId extends string>({
  tab,
  onTabChange,
  tabs,
  className,
}: FocusTabBarProps<TTabId>) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const idx = tabs.findIndex((t) => t.id === tab);
    if (idx === -1) return;
    const next =
      event.key === "ArrowRight"
        ? tabs[(idx + 1) % tabs.length]
        : tabs[(idx - 1 + tabs.length) % tabs.length];
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
      {tabs.map((t) => {
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
