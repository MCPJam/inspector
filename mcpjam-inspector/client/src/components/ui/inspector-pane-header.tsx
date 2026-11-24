import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@mcpjam/design-system/cn";

export interface InspectorPaneTab<T extends string> {
  id: T;
  label: string;
  /** Shown after the label in a smaller face. Omit to show no count. */
  count?: number | string;
  /** What the count counts, on hover. A bare number is easy to misread. */
  countTitle?: string;
}

/**
 * The header row of an inspector left pane (Tools, Events): tabs on the
 * left, small icon actions beside them, and one primary action on the right.
 * In a narrow pane the tabs scroll sideways, so the actions stay in view and
 * the row never makes the pane wider than it is.
 *
 * It owns layout and tab semantics only. Each caller supplies its own
 * actions, so running, saving and subscribing stay with the pane that knows
 * how to do them.
 */
export function InspectorPaneHeader<T extends string>({
  tabs,
  activeTab,
  onTabChange,
  ariaLabel,
  secondaryActions,
  primaryAction,
  compact = false,
}: {
  tabs: InspectorPaneTab<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  /** Names the tab list for screen readers. */
  ariaLabel: string;
  secondaryActions?: ReactNode;
  primaryAction?: ReactNode;
  /** Reduce tab spacing when a pane has several navigation labels. */
  compact?: boolean;
}) {
  const tabRefs = useRef(new Map<T, HTMLButtonElement>());

  // Arrow keys move between tabs and select them, as a tab list should.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === activeTab);
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index <= 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null || !tabs[next]) return;
    event.preventDefault();
    onTabChange(tabs[next].id);
    tabRefs.current.get(tabs[next].id)?.focus();
  };

  return (
    <div className="border-b border-border flex-shrink-0">
      <div className="px-2 py-2 flex min-w-0 items-center gap-2">
        <div
          role="tablist"
          aria-label={ariaLabel}
          className={cn(
            "flex min-w-0 items-center overflow-x-auto [scrollbar-width:none]",
            compact ? "gap-1" : "gap-1.5",
          )}
          onKeyDown={onKeyDown}
        >
          {tabs.map((tab) => {
            const selected = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                ref={(node) => {
                  if (node) tabRefs.current.set(tab.id, node);
                  else tabRefs.current.delete(tab.id);
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTabChange(tab.id)}
                className={cn(
                  "shrink-0 whitespace-nowrap py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer",
                  compact ? "px-1.5" : "px-3",
                  selected
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
                {tab.count !== undefined ? (
                  <span
                    className="ml-1 text-[10px] font-mono opacity-70"
                    title={tab.countTitle}
                  >
                    {tab.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {secondaryActions ? (
          <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground/80">
            {secondaryActions}
          </div>
        ) : null}

        {primaryAction ? (
          <div className="ml-auto shrink-0">{primaryAction}</div>
        ) : null}
      </div>
    </div>
  );
}
