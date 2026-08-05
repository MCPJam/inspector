import { useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useSlackAgentSettingsEnabled } from "@/hooks/useSlackAgentSettingsEnabled";
import { SlackConnectionsTab } from "./SlackConnectionsTab";
import { SlackCapabilitiesTab } from "./SlackCapabilitiesTab";
import { SlackActivityTab } from "./SlackActivityTab";

/**
 * Org settings for the MCPJam agent in Slack.
 *
 * ONE org section with `?tab=` sub-tabs, not three nav entries: Connections,
 * Capabilities and Activity are three views of one decision ("how does our org
 * run the agent"), and three top-level entries would push the org settings
 * strip past the point where anyone reads it.
 *
 * SELF-ENFORCES THE FLAG. The tab strip already hides the entry, but a user
 * who types `/organizations/:id/slack` bypasses the strip entirely — so the
 * component checks too rather than trusting its caller.
 */

export const SLACK_SETTINGS_TABS = [
  {
    id: "connections",
    label: "Connections",
    description:
      "Which Slack workspaces this organization uses, and where turns land by default.",
  },
  {
    id: "capabilities",
    label: "Capabilities",
    description: "Which agent tools are available to this organization.",
  },
  {
    id: "activity",
    label: "Activity",
    description: "What the agent proposed, who approved it, and how it went.",
  },
] as const;

export type SlackSettingsTabId = (typeof SLACK_SETTINGS_TABS)[number]["id"];

/** An unknown or absent `?tab=` lands on Connections. */
export function resolveSlackSettingsTab(value: unknown): SlackSettingsTabId {
  return SLACK_SETTINGS_TABS.some((tab) => tab.id === value)
    ? (value as SlackSettingsTabId)
    : "connections";
}

interface SlackAgentSettingsSectionProps {
  organizationId: string;
  /** Org admin or owner. Members get a read-only view of every tab. */
  isAdmin: boolean;
  /** Raw `?tab=` value; normalized here so callers do not have to. */
  tab?: string | null;
  onTabChange?: (tab: SlackSettingsTabId) => void;
}

export function SlackAgentSettingsSection({
  organizationId,
  isAdmin,
  tab,
  onTabChange,
}: SlackAgentSettingsSectionProps) {
  const enabled = useSlackAgentSettingsEnabled();
  const activeTab = useMemo(() => resolveSlackSettingsTab(tab), [tab]);

  const handleTabChange = useCallback(
    (next: SlackSettingsTabId) => onTabChange?.(next),
    [onTabChange]
  );

  if (!enabled) return null;

  const active = SLACK_SETTINGS_TABS.find((entry) => entry.id === activeTab)!;

  return (
    <div className="space-y-6" data-testid="slack-agent-settings">
      <div
        className="flex items-end gap-1 border-b border-border/60"
        role="tablist"
        aria-label="Slack agent settings"
      >
        {SLACK_SETTINGS_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`slack-settings-tab-${entry.id}`}
            aria-controls={`slack-settings-panel-${entry.id}`}
            aria-selected={entry.id === activeTab}
            onClick={() => handleTabChange(entry.id)}
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
        id={`slack-settings-panel-${activeTab}`}
        aria-labelledby={`slack-settings-tab-${activeTab}`}
        className="space-y-6"
      >
        <p className="text-sm text-muted-foreground">{active.description}</p>

        {activeTab === "connections" ? (
          <SlackConnectionsTab
            organizationId={organizationId}
            isAdmin={isAdmin}
          />
        ) : activeTab === "capabilities" ? (
          <SlackCapabilitiesTab
            organizationId={organizationId}
            isAdmin={isAdmin}
          />
        ) : (
          <SlackActivityTab organizationId={organizationId} />
        )}
      </div>
    </div>
  );
}
