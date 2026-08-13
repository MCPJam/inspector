import { SurfaceActivityTab } from "../surface/SurfaceActivityTab";

/**
 * Slack's Activity tab.
 *
 * The implementation moved to `SurfaceActivityTab` when Discord needed the
 * same feed — the backing query already returned both surfaces' rows. This
 * stays as the Slack-named entry point so `SlackAgentSettingsSection` and its
 * tests keep importing the name they always did, matching what
 * `SlackConnectionsTab` does for the same reason.
 *
 * Behavior change worth knowing about: this tab now shows only `slack.agent.*`
 * rows. It previously rendered Discord rows too, as raw action strings
 * attributed to "Slack <a discord user id>".
 */

interface SlackActivityTabProps {
  organizationId: string;
}

export function SlackActivityTab({ organizationId }: SlackActivityTabProps) {
  return (
    <SurfaceActivityTab organizationId={organizationId} surfaceKind="slack" />
  );
}
