import { useCallback, useMemo } from "react";
import { Button } from "@mcpjam/design-system/button";
import { useDiscordAgentEnabled } from "@/hooks/useDiscordAgentEnabled";
import { discordInstallUrl } from "@/lib/config";
import { SurfaceConnectionsTab } from "../surface/SurfaceConnectionsTab";
import { SurfaceActivityTab } from "../surface/SurfaceActivityTab";
import { SurfaceSettingsTabs } from "../surface/SurfaceSettingsTabs";

/**
 * Org settings for the MCPJam agent in Discord.
 *
 * TWO TABS, NOT SLACK'S THREE. Connections and Activity are shared components
 * (`SurfaceConnectionsTab`, `SurfaceActivityTab`) rendered inside the shared
 * strip, so the two surfaces stay the same screen rather than two screens that
 * drift. Capabilities is the one real absence, and it is deliberate:
 *
 *   CAPABILITIES is org-wide in the backend, not per-surface
 *   (`orgAgentCapabilityPolicies` is read with `surfaceKind: 'slack'` for
 *   every caller). A Discord tab here would render a second control over the
 *   same single row and imply the two can differ. Splitting the policy per
 *   surface is a product decision about existing Slack behavior, so it is its
 *   own change — not something to imply with a tab.
 *
 * SELF-ENFORCES THE FLAG, like Slack's section does: the nav strip already
 * hides the entry, but someone who types `/organizations/:id/discord` bypasses
 * the strip entirely.
 */

export const DISCORD_SETTINGS_TABS = [
  {
    id: "connections",
    label: "Connections",
    description:
      "Which Discord servers this organization uses, and where turns land by default.",
  },
  {
    id: "activity",
    label: "Activity",
    description: "What the agent proposed, who approved it, and how it went.",
  },
] as const;

export type DiscordSettingsTabId = (typeof DISCORD_SETTINGS_TABS)[number]["id"];

/** An unknown or absent `?tab=` lands on Connections. */
export function resolveDiscordSettingsTab(
  value: unknown
): DiscordSettingsTabId {
  return DISCORD_SETTINGS_TABS.some((tab) => tab.id === value)
    ? (value as DiscordSettingsTabId)
    : "connections";
}

interface DiscordAgentSettingsSectionProps {
  organizationId: string;
  /** Org admin or owner. Members get a read-only view. */
  isAdmin: boolean;
  /** Raw `?tab=` value; normalized here so callers do not have to. */
  tab?: string | null;
  onTabChange?: (tab: DiscordSettingsTabId) => void;
}

export function DiscordAgentSettingsSection({
  organizationId,
  isAdmin,
  tab,
  onTabChange,
}: DiscordAgentSettingsSectionProps) {
  const enabled = useDiscordAgentEnabled();
  const activeTab = useMemo(() => resolveDiscordSettingsTab(tab), [tab]);
  const handleTabChange = useCallback(
    (next: DiscordSettingsTabId) => onTabChange?.(next),
    [onTabChange]
  );
  // Absent when no client id is configured. An install URL built without one
  // lands on a Discord error page that reads as our bug rather than as
  // missing configuration, so the button is omitted instead of broken.
  const installUrl = discordInstallUrl();

  if (!enabled) return null;

  return (
    <div className="space-y-6" data-testid="discord-agent-settings">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-prose text-sm text-muted-foreground">
          A server appears here once someone in this organization runs{" "}
          <code className="font-mono text-xs">/mcpjam connect</code> in it.
        </p>
        {isAdmin && installUrl ? (
          <Button asChild variant="outline" size="sm">
            <a href={installUrl} target="_blank" rel="noreferrer">
              Add to a server
            </a>
          </Button>
        ) : null}
      </div>

      <SurfaceSettingsTabs
        tabs={DISCORD_SETTINGS_TABS}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        idPrefix="discord-settings"
        ariaLabel="Discord agent settings"
      >
        {activeTab === "connections" ? (
          <SurfaceConnectionsTab
            organizationId={organizationId}
            isAdmin={isAdmin}
            surfaceKind="discord"
          />
        ) : (
          <SurfaceActivityTab
            organizationId={organizationId}
            surfaceKind="discord"
          />
        )}
      </SurfaceSettingsTabs>
    </div>
  );
}
