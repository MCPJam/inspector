import { Navigate } from "react-router";
import { useConvexAuth } from "convex/react";
import { ChevronRight, Github, Slack } from "lucide-react";
import { useAppNavigate } from "@/lib/app-navigation";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useOrganizationQueries } from "@/hooks/useOrganizations";
import { SettingsNav } from "./SettingsNav";
import { useGithubChecksSettings } from "@/hooks/useGithubChecksSettings";

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
 */

interface IntegrationsRouteProps {
  activeOrganizationId?: string | null;
}

function IntegrationCard({
  icon,
  title,
  description,
  status,
  onSelect,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  status: string;
  onSelect: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={testId}
      className="w-full flex items-center justify-between gap-4 px-4 py-3 rounded-md border border-border/40 bg-muted/20 text-left transition-colors hover:bg-muted/40"
    >
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

export function IntegrationsRoute({
  activeOrganizationId,
}: IntegrationsRouteProps = {}) {
  const appNavigate = useAppNavigate();
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
    <div className="h-full overflow-y-auto">
      <div className="p-10 space-y-8 max-w-3xl">
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold">Settings</h1>
          <SettingsNav
            active="integrations"
            activeOrganizationId={activeOrganizationId}
          />
        </div>

        <p className="text-sm text-muted-foreground">
          Connect MCPJam to the services your team already uses.
        </p>

        <div className="space-y-2">
          <ErrorBoundary fallback={null}>
            <GithubChecksCard activeOrganizationId={activeOrganizationId} />
          </ErrorBoundary>

          {/*
           * Slack is configured PER PROJECT (see `ProjectSettingsTab`'s
           * Integrations section), while this page is org-scoped. Rather than
           * pretend otherwise with a status this page cannot read, the card
           * says where the setting lives and takes you there.
           */}
          <IntegrationCard
            testId="integration-card-slack"
            icon={<Slack className="size-4 text-primary" aria-hidden />}
            title="Slack"
            description="Send eval results and agent activity to a Slack channel."
            status="Configured per project"
            onSelect={() => appNavigate("/project-settings")}
          />
        </div>
      </div>
    </div>
  );
}
