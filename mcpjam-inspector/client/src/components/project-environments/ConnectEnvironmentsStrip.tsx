import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { ArrowRight, Layers } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { useHostList } from "@/hooks/useClients";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { usePreviewedEnvironmentId } from "@/hooks/use-previewed-environment-id";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { cn } from "@/lib/utils";

/**
 * Connect-canvas Environments strip (Project Environments — Phase 2.6).
 *
 * A compact entry point, not a management surface: editing stays on
 * `/environments`, and the ONE action here is "Open in Playground".
 *
 * ## Why the cards look thin
 *
 * Every field shown comes from the environment ROW that
 * `projectEnvironments:listEnvironments` already returns, plus the host name
 * from the hosts query Connect already runs. Nothing here triggers a runtime
 * resolve, because a resolve is one round trip PER ENVIRONMENT — an N+1 on a
 * list that renders on every Connect visit.
 *
 * That is also why there is no resolved server count on a row. The row stores a
 * `serverAttachmentId` (a scope), not a server set; the actual set folds in the
 * host's own picks and any plugin-contributed servers, both of which are LIVE.
 * Printing a number here would mean either lying or paying the N+1, so the card
 * says whether a server group is attached and stops there. The real count shows
 * up in the Playground, where exactly one environment is resolved for real.
 *
 * Skill and plugin counts ARE honest row data: `skillSelection.skillIds` is the
 * explicit pinned selection and `pluginVersionIds` are pinned version ids —
 * both stored, both exact. They are labeled as PINS, not as totals, because the
 * host and plugin channels contribute more skills at resolve time.
 */
export function ConnectEnvironmentsStrip({
  projectId,
  className,
}: {
  projectId: string | null;
  className?: string;
}) {
  const enabled = useProjectEnvironmentsEnabled();
  const { isAuthenticated } = useConvexAuth();
  // Live rows only — an archived environment can't be launched.
  const environments = useProjectEnvironments(enabled ? projectId : null);
  const { hosts } = useHostList({
    isAuthenticated,
    projectId: enabled ? projectId : null,
  });
  const [, setPreviewedEnvironmentId] = usePreviewedEnvironmentId(projectId);

  const hostNamesById = useMemo(
    () => new Map(hosts.map((host) => [host.hostId, host.name])),
    [hosts]
  );

  // Render nothing at all when there is nothing to offer: an empty strip on the
  // Connect canvas is pure noise for the (currently large) majority of projects
  // with no environments.
  if (!enabled || !projectId) return null;
  if (!environments || environments.length === 0) return null;

  return (
    <div
      className={cn(
        "rounded-lg border border-border/50 bg-muted/15 space-y-2 p-3",
        className
      )}
      data-testid="connect-environments-strip"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Layers className="size-3.5" aria-hidden />
          Environments
        </h3>
        <Button
          variant="link"
          size="sm"
          className="h-auto shrink-0 p-0 text-xs"
          onClick={() => navigateApp(routePaths.environments)}
          data-testid="connect-environments-manage"
        >
          Manage
          <ArrowRight className="ml-1 h-3 w-3" />
        </Button>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-0.5">
        {environments.map((environment) => {
          const hostName =
            hostNamesById.get(environment.hostId) ?? "Unknown client";
          const pinnedSkillCount =
            environment.skillSelection?.skillIds.length ?? 0;
          const pluginPinCount = environment.pluginVersionIds?.length ?? 0;
          return (
            <div
              key={environment.environmentId}
              className="flex min-w-[240px] shrink-0 flex-col gap-1.5 rounded-md border border-border/40 bg-background/60 p-2.5"
              data-testid={`connect-environment-card-${environment.environmentId}`}
            >
              <p className="truncate text-sm font-medium">{environment.name}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {hostName}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {environment.serverAttachmentId
                  ? "Server group attached"
                  : "Client's own servers"}
                {" · "}
                {pinnedSkillCount} skill pin{pinnedSkillCount === 1 ? "" : "s"}
                {" · "}
                {pluginPinCount} plugin pin{pluginPinCount === 1 ? "" : "s"}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-0.5 h-7 w-full text-xs"
                onClick={() => {
                  setPreviewedEnvironmentId(environment.environmentId);
                  navigateApp(routePaths.playground);
                }}
                data-testid={`connect-environment-open-${environment.environmentId}`}
              >
                Open in Playground
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
