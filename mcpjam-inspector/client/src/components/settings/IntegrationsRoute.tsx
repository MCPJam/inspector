import { Navigate } from "react-router";
import { useConvexAuth } from "convex/react";
import {
  ChevronRight,
  Github,
  MessageSquare,
  Radio,
  Slack,
} from "lucide-react";
import { buildOrganizationPath, useAppNavigate } from "@/lib/app-navigation";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ErrorCard } from "@/components/ui/error-card";
import { useOrganizationQueries } from "@/hooks/useOrganizations";
import { useOrgSlackSettings } from "@/hooks/useOrgSlackSettings";
import { SettingsPageShell } from "./SettingsPageShell";
import { useGithubChecksSettings } from "@/hooks/useGithubChecksSettings";
import { useDiscordAgentEnabled } from "@/hooks/useDiscordAgentEnabled";
import { useTraceDestinationsEnabled } from "@/hooks/useTraceDestinationsEnabled";
import {
  useOrgTraceDestinations,
  useTraceDestinationsAvailability,
} from "@/hooks/useOrgTraceDestinations";

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
    (workspace) => workspace.installed,
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
 * This card used to LEAVE the app, straight to Discord's install URL, because
 * there was no org-scoped Discord settings page to send anyone to. There is
 * now, so it navigates in-app like the other two — and the install link moved
 * onto that page, next to the server list it affects, where "add the bot"
 * reads as one step of setup rather than the whole of it.
 *
 * Still flag-gated, and still fail-closed while flags load: the agent is dark,
 * and a settings page for a bot that cannot answer is worse than no entry.
 */
function DiscordCard({
  activeOrganizationId,
}: {
  activeOrganizationId: string;
}) {
  const appNavigate = useAppNavigate();
  const enabled = useDiscordAgentEnabled();
  // THE FLAG HAS TO REACH THE QUERY, not just the render. A hook cannot be
  // called conditionally, so `if (!enabled) return null` below happens too
  // late — the query would already have fired for every visitor to this page,
  // including flagged-off ones. That matters because this is the one call
  // that sends `surfaceKind: "discord"`, which a backend deployed before that
  // argument existed rejects: the throw would hit this card's error boundary
  // and render an ErrorCard to someone who should see no Discord entry at all.
  // A null organization id is the hook's own documented skip.
  const { connections } = useOrgSlackSettings(
    enabled ? activeOrganizationId : null,
    "discord",
  );

  if (!enabled) return null;

  // Same `undefined` reasoning as the other two cards: still-asking is not
  // none-connected, and saying "Not connected" in that window tells a
  // connected org their setup is gone.
  const connectedCount = connections?.workspaces.filter(
    (workspace) => workspace.installed,
  ).length;
  const status =
    connections === undefined
      ? ""
      : !connectedCount
        ? "Not connected"
        : `${connectedCount} ${connectedCount === 1 ? "server" : "servers"} connected`;

  return (
    <IntegrationCard
      testId="integration-card-discord"
      icon={<MessageSquare className="size-4 text-primary" aria-hidden />}
      title="Discord"
      description="Mention the agent in a channel to run and approve evals."
      status={status}
      onSelect={() =>
        appNavigate(buildOrganizationPath(activeOrganizationId, "discord"))
      }
    />
  );
}

/**
 * Trace destinations — where this organization's traces are streamed.
 *
 * Flag-gated for the same reason as Discord, and with the same care about
 * WHERE the flag is applied: the client flag decides whether to query at all,
 * because the availability read is signed-in and org-scoped and a backend
 * deployed before it existed throws. That throw would hit this card's error
 * boundary and render an ErrorCard to someone who should see no observability
 * entry at all.
 *
 * The card still asks the SERVER before showing itself. The client flag is an
 * advertising decision; `getAvailability` is the access one, and only it knows
 * whether this particular organization is covered.
 */
function ObservabilityCard({
  activeOrganizationId,
}: {
  activeOrganizationId: string;
}) {
  const appNavigate = useAppNavigate();
  const enabled = useTraceDestinationsEnabled();
  const availability = useTraceDestinationsAvailability(
    enabled ? activeOrganizationId : null,
  );
  // GATED ON THE SERVER'S ANSWER, not just the flag. A flagged-in member of an
  // organization the server has NOT covered would otherwise fire this
  // org-scoped read for a feature they cannot use, and its refusal would reach
  // the boundary as an ErrorCard for a card that should not be there at all.
  const { destinations } = useOrgTraceDestinations(
    availability?.state === "enabled" ? activeOrganizationId : null,
  );

  if (!enabled) return null;
  // `undefined` is still-asking, and `disabled`/`unavailable` are answers.
  // None of the three is a card.
  if (availability?.state !== "enabled") return null;

  // Same `undefined` reasoning as the other cards: still-asking is not
  // none-configured, and saying "Not configured" in that window tells an org
  // with a live destination that their setup is gone.
  const paused = destinations?.some((d) => d.paused !== null);
  const active = destinations?.filter((d) => d.enabled && !d.paused).length;
  const status =
    destinations === undefined
      ? ""
      : paused
        ? "Paused — needs attention"
        : !active
          ? "Not configured"
          : `${active} ${active === 1 ? "destination" : "destinations"} streaming`;

  return (
    <IntegrationCard
      testId="integration-card-observability"
      icon={<Radio className="size-4 text-primary" aria-hidden />}
      title="Observability"
      description="Stream traces to Coralogix, Honeycomb, or any OTLP endpoint."
      status={status}
      onSelect={() =>
        appNavigate(
          buildOrganizationPath(activeOrganizationId, "observability"),
        )
      }
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
        <ErrorBoundary
          name="integrations_github_checks"
          fallback={({ error, reset }) => (
            <ErrorCard error={error} onRetry={reset} />
          )}
        >
          <GithubChecksCard activeOrganizationId={activeOrganizationId} />
        </ErrorBoundary>

        <ErrorBoundary
          name="integrations_slack"
          fallback={({ error, reset }) => (
            <ErrorCard error={error} onRetry={reset} />
          )}
        >
          <SlackIntegrationCard activeOrganizationId={activeOrganizationId} />
        </ErrorBoundary>

        <ErrorBoundary
          name="integrations_discord"
          fallback={({ error, reset }) => (
            <ErrorCard error={error} onRetry={reset} />
          )}
        >
          <DiscordCard activeOrganizationId={activeOrganizationId} />
        </ErrorBoundary>

        {/*
          RENDERS NOTHING ON A THROW, unlike its three siblings above.
          Those surfaces are generally available, so an error card is the
          honest answer when their backend misbehaves. This one is dark: the
          ordinary way to reach this boundary is a client flagged on against a
          backend that has not deployed `traceDestinations:getAvailability`
          yet, and an error card there advertises a feature to someone who
          cannot use it while telling them nothing they can act on. The
          boundary is still required — without it the throw takes the whole
          Integrations page down — and it still reports to Sentry, because
          silent to the USER is a UI choice and never a telemetry one.
        */}
        <ErrorBoundary name="integrations_observability" fallback={null}>
          <ObservabilityCard activeOrganizationId={activeOrganizationId} />
        </ErrorBoundary>
      </div>
    </SettingsPageShell>
  );
}
