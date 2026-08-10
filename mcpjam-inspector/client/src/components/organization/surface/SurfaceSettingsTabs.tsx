import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The tab strip shared by the Slack and Discord org settings sections.
 *
 * Extracted rather than copied because the interesting part is the
 * accessibility detail, not the layout: only the ACTIVE tab's panel is
 * mounted, so only the active tab may carry `aria-controls` — pointing the
 * others at ids that are not in the document gives a screen reader a target
 * it cannot move to, which is worse than the attribute being absent. That is
 * exactly the kind of rule a second hand-written copy loses.
 *
 * Generic over the tab id so each caller keeps its own literal union and
 * `onTabChange` stays typed end to end.
 */

export interface SurfaceSettingsTab<Id extends string> {
  id: Id;
  label: string;
  description: string;
}

interface SurfaceSettingsTabsProps<Id extends string> {
  tabs: readonly SurfaceSettingsTab<Id>[];
  activeTab: Id;
  onTabChange: (tab: Id) => void;
  /** `slack-settings` → `slack-settings-tab-connections`. */
  idPrefix: string;
  /** Names the tablist for screen readers, e.g. "Slack agent settings". */
  ariaLabel: string;
  children: ReactNode;
}

export function SurfaceSettingsTabs<Id extends string>({
  tabs,
  activeTab,
  onTabChange,
  idPrefix,
  ariaLabel,
  children,
}: SurfaceSettingsTabsProps<Id>) {
  const active = tabs.find((entry) => entry.id === activeTab);

  return (
    <>
      <div
        className="flex items-end gap-1 border-b border-border/60"
        role="tablist"
        aria-label={ariaLabel}
      >
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${entry.id}`}
            aria-controls={
              entry.id === activeTab
                ? `${idPrefix}-panel-${entry.id}`
                : undefined
            }
            aria-selected={entry.id === activeTab}
            onClick={() => onTabChange(entry.id)}
            className={cn(
              "-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors sm:px-4",
              entry.id === activeTab
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`${idPrefix}-panel-${activeTab}`}
        aria-labelledby={`${idPrefix}-tab-${activeTab}`}
        className="space-y-6"
      >
        {active ? (
          <p className="text-sm text-muted-foreground">{active.description}</p>
        ) : null}
        {children}
      </div>
    </>
  );
}
