import { Navigate } from "react-router";
import { useConvexAuth } from "convex/react";
import { ChevronRight, Github, MessageSquare, Slack } from "lucide-react";
import { buildOrganizationPath, useAppNavigate } from "@/lib/app-navigation";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useOrganizationQueries } from "@/hooks/useOrganizations";
import { useOrgSlackSettings } from "@/hooks/useOrgSlackSettings";
import { SettingsPageShell } from "./SettingsPageShell";
import { useGithubChecksSettings } from "@/hooks/useGithubChecksSettings";
import { useDiscordAgentEnabled } from "@/hooks/useDiscordAgentEnabled";
import { discordInstallUrl } from "@/lib/config";

/**
 * `/settings/integrations` — the one place a connectable outside service is
 * listed.
 *
 * A CARD LIST, not a tab per integration. The tab row is shared by every
 * settings page, so one tab per service grows it forever and pushes the ones
 * people actually use off the edge; a card list absorbs the next service for
 * free. That is also why this page stays a directory: each card owns a single
 * sentence about what the service does and its current state, and the
 * configuration itself lives on the service's own page.
 *
 * The TAB is unconditional — Slack exists for every org, so there is always at
 * least one card. The GITHUB CARD carries its own availability gate. That split
 * matters: gating the tab on GitHub would hide Slack from anyone without the
 * GitHub beta, which is the reachability bug in the other direction.
 *
 * Slack is org-scoped, not per-project: notifications go to channels bound
 * from `organizations/:orgId/slack` (the Connections tab), which is also
 * where the MCPJam Slack app gets installed. There used to be a per-project
 * incoming-webhook integration configured from `ProjectSettingsTab` — it's
 * retired; this card is now the only Slack entry point.
 */

interface IntegrationsRouteProps {
  activeOrganizationId?: string | null;
}

/**
 * `onSelect` navigates in-app; `href` leaves for the service's own site. A
 * card has exactly one of the two — an anchor rather than a button-that-calls-
 * `window.open`, so the destination shows in the status bar, middle-click and
 * "open in new tab" work, and screen readers announce it as a link.
 */
function IntegrationCard({
  icon,
  title,
  description,
  status,
  onSelect,
  href,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  status: string;
  onSelect?: () => void;
  href?: string;
  testId: string;
}) {
  const className =
    "w-full flex items-center justify-between gap-4 px-4 py-3 rounded-md border border-border/40 bg-muted/20 text-left transition-colors hover:bg-muted/40";
  const Inner = (
    <>
      <div className="flex items-center gap-3 min-w-0">
        <div className="size-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium truncate">{title}</span>
          <span className="text-xs text-muted-foreground">{description}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-muted-foreground">{status}</span>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
      </div>
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        data-testid={testId}
        className={className}
      >
        {Inner}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={testId}
      className={className}
    >
      {Inner}
    </button>
  );
}

/**
 * The GitHub card, isolated behind its own boundary for the same reason the nav
 * tab used to be: `useQuery` throws when availability cannot be resolved (the
 * backend function is not deployed yet, or the caller is not a member of the
 * active org), and unhandled that would blank the whole page — including the
 * Slack card, which has nothing to do with GitHub.
 */
function GithubChecksCard({
  activeOrganizationId,
}: {
  activeOrganizationId?: string | null;
}) {
  const appNavigate = useAppNavigate();
  const { availability, repos } = useGithubChecksSettings(activeOrganizationId);

  if (availability?.state !== "enabled") return null;

  // `undefined` is "still asking", which is NOT "none connected" — saying
  // "Not connected" while the list is in flight tells a connected org their
  // setup is gone, so stay quiet until it lands.
  const status =
    repos === undefined
      ? ""
      : repos.length === 0
      ? "Not connected"
      : `${repos.length} ${
          repos.length === 1 ? "repository" : "repositories"
        } connected`;

  return (
    <IntegrationCard
      testId="integration-card-github"
      icon={<Github className="size-4 text-primary" aria-hidden />}
      title="GitHub Checks"
      description="Run an eval suite on every pull request."
      status={status}
      onSelect={() => appNavigate("/settings/integrations/github")}
    />
  );
}

/**
 * The Slack card, isolated behind its own boundary for the same reason the
 * GitHub one is: `useOrgSlackSettings` subscribes to a `useQuery` that throws
 * on error (backend not deployed yet, caller not a member of the active
 * org), and unhandled that would blank the whole page.
 */
function SlackIntegrationCard({
  activeOrganizationId,
}: {
  activeOrganizationId: string;
}) {
  const appNavigate = useAppNavigate();
  const { connections } = useOrgSlackSettings(activeOrganizationId);

  // `undefined` is "still asking" — same reasoning as the GitHub card's
  // repo count: reporting "Not connected" in that window would tell a
  // connected org their setup is gone.
  const installedCount = connections?.workspaces.filter(
    (workspace) => workspace.installed
  ).length;
  const status =
    connections === undefined
      ? ""
      : !installedCount
      ? "Not connected"
      : `${installedCount} ${
          installedCount === 1 ? "workspace" : "workspaces"
        } connected`;

  return (
    <IntegrationCard
      testId="integration-card-slack"
      icon={<Slack className="size-4 text-primary" aria-hidden />}
      title="Slack"
      description="Post eval failures and agent activity to Slack channels."
      status={status}
      onSelect={() =>
        appNavigate(buildOrganizationPath(activeOrganizationId, "slack"))
      }
    />
  );
}

/**
 * The Discord agent.
 *
 * Unlike the other two, this card LEAVES the app. Discord's setup does not
 * happen here and cannot: an admin adds the bot to a server, and then each
 * member links their own account from inside Discord with `/mcpjam connect`.
 * There is no org-scoped Discord settings page yet — when there is, this
 * becomes an in-app `onSelect` like the others, and the copy changes with it.
 *
 * Two gates, both fail-closed. The FLAG, because the agent is dark; and the
 * CLIENT ID, because an install URL built without one lands on a Discord
 * error page that reads as our bug rather than as missing configuration.
 * Saying nothing is better than offering an install that cannot work.
 */
function DiscordCard() {
  const enabled = useDiscordAgentEnabled();
  const installUrl = discordInstallUrl();
  if (!enabled || !installUrl) return null;

  return (
    <IntegrationCard
      testId="integration-card-discord"
      icon={<MessageSquare className="size-4 text-primary" aria-hidden />}
      title="Discord"
      description="Mention the agent in a channel to run and approve evals."
      // Not "Not connected": this page is org-scoped and a Discord link is
      // per-member, so it cannot honestly report a connection state. It
      // reports the ACTION instead.
      status="Add to a server"
      href={installUrl}
    />
  );
}

export function IntegrationsRoute({
  activeOrganizationId,
}: IntegrationsRouteProps = {}) {
  // Same bootstrap dance as the GitHub page: `activeOrganizationId` arrives
  // asynchronously and "absent" is indistinguishable from "not resolved yet",
  // so wait for auth AND the org list to settle before treating it as missing.
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const { isLoading: organizationsLoading } = useOrganizationQueries({
    isAuthenticated,
  });

  if (!activeOrganizationId) {
    if (authLoading || organizationsLoading) return null;
    return <Navigate to="/settings" replace />;
  }

  return (
    <SettingsPageShell
      active="integrations"
      activeOrganizationId={activeOrganizationId}
    >
      <p className="max-w-prose text-sm text-muted-foreground">
        Connect MCPJam to the services your team already uses.
      </p>

      <div className="space-y-2">
        <ErrorBoundary fallback={null}>
          <GithubChecksCard activeOrganizationId={activeOrganizationId} />
        </ErrorBoundary>

        <ErrorBoundary fallback={null}>
          <SlackIntegrationCard activeOrganizationId={activeOrganizationId} />
        </ErrorBoundary>

        <DiscordCard />
      </div>
    </SettingsPageShell>
  );
}
