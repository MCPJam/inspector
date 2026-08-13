import { SurfaceConnectionsTab } from "../surface/SurfaceConnectionsTab";

/**
 * Slack's Connections tab.
 *
 * The implementation moved to `SurfaceConnectionsTab` when Discord needed the
 * same three controls over the same tables. This stays as the Slack-named
 * entry point so `SlackAgentSettingsSection` and its tests keep importing the
 * name they always did — the alternative was renaming a live tab's module in
 * the same change that added a second surface, which would have made the diff
 * about the rename instead of about Discord.
 */

interface SlackConnectionsTabProps {
  organizationId: string;
  isAdmin: boolean;
}

export function SlackConnectionsTab({
  organizationId,
  isAdmin,
}: SlackConnectionsTabProps) {
  return (
    <SurfaceConnectionsTab
      organizationId={organizationId}
      isAdmin={isAdmin}
      surfaceKind="slack"
    />
  );
}
