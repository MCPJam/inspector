import { Button } from "@mcpjam/design-system/button";
import { useDiscordAgentEnabled } from "@/hooks/useDiscordAgentEnabled";
import { discordInstallUrl } from "@/lib/config";
import { SurfaceConnectionsTab } from "../surface/SurfaceConnectionsTab";

/**
 * Org settings for the MCPJam agent in Discord.
 *
 * ONE VIEW, NOT THREE. Slack's section carries Connections, Capabilities and
 * Activity sub-tabs; Discord has only Connections, and the two absences are
 * deliberate rather than unfinished:
 *
 *   - CAPABILITIES is org-wide in the backend, not per-surface
 *     (`orgAgentCapabilityPolicies` is read with `surfaceKind: 'slack'` for
 *     every caller). A Discord tab here would render a second control over the
 *     same single row and imply the two can differ. Splitting the policy per
 *     surface is a product decision about existing Slack behavior, so it is
 *     its own change.
 *   - ACTIVITY reads `auditEvents`, which now carry `discord.agent.*` actions,
 *     but the Slack tab's copy and filters are written around Slack's
 *     vocabulary. Showing Discord rows there is a follow-up, not a blocker for
 *     binding a channel.
 *
 * A tab strip for a single tab would be chrome asserting choices that do not
 * exist, so the section renders the one view directly.
 *
 * SELF-ENFORCES THE FLAG, like Slack's section does: the nav strip already
 * hides the entry, but someone who types `/organizations/:id/discord` bypasses
 * the strip entirely.
 */

interface DiscordAgentSettingsSectionProps {
  organizationId: string;
  /** Org admin or owner. Members get a read-only view. */
  isAdmin: boolean;
}

export function DiscordAgentSettingsSection({
  organizationId,
  isAdmin,
}: DiscordAgentSettingsSectionProps) {
  const enabled = useDiscordAgentEnabled();
  // Absent when no client id is configured. An install URL built without one
  // lands on a Discord error page that reads as our bug rather than as
  // missing configuration, so the button is omitted instead of broken.
  const installUrl = discordInstallUrl();
  if (!enabled) return null;

  return (
    <div className="space-y-6" data-testid="discord-agent-settings">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-prose text-sm text-muted-foreground">
          Which Discord servers this organization uses, and where turns land by
          default. A server appears below once someone here runs{" "}
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
      <SurfaceConnectionsTab
        organizationId={organizationId}
        isAdmin={isAdmin}
        surfaceKind="discord"
      />
    </div>
  );
}
