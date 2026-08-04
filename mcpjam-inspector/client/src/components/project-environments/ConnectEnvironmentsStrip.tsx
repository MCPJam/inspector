import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { ArrowRight, Layers, Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { useHostList } from "@/hooks/useClients";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { usePreviewedEnvironmentId } from "@/hooks/use-previewed-environment-id";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useSandboxImages } from "@/hooks/useSandboxImages";
import { shouldQueryProjectId, useProjectMembers } from "@/hooks/useProjects";
import { saveEnvironmentDraftSeed } from "@/lib/environment-draft-seed";
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
  // Normalize ONCE, then feed every hook the same value. `useProjectEnvironments`
  // trims internally, so a whitespace-padded id renders rows — while `useHostList`
  // and the previewed-environment storage would key off the raw string, leaving
  // every card labeled "Unknown client" and writing the selection under a scope
  // the Playground never reads.
  const normalizedProjectId = projectId?.trim() || null;
  // Live rows only — an archived environment can't be launched.
  const environments = useProjectEnvironments(
    enabled ? normalizedProjectId : null
  );
  const { hosts } = useHostList({
    isAuthenticated,
    projectId: enabled ? normalizedProjectId : null,
  });
  const [, setPreviewedEnvironmentId] =
    usePreviewedEnvironmentId(normalizedProjectId);
  const [previewedHostId] = usePreviewedHostId(normalizedProjectId);
  // Environment writes are project-admin-gated (the editor is read-only for
  // members), so the capture CTA is hidden for non-admins rather than leading
  // them into a form they can't save. Same client mirror of the backend gate
  // ServersTab uses for project-server settings; Convex dedupes the query.
  // `useProjectMembers` gates only on truthiness, so — unlike the environment
  // and host queries above — a transient/local project id would reach Convex as
  // an invalid id and throw a validation error while Connect is still resolving
  // its shared project. Apply the same guard those queries use.
  const { canManageMembers: canManageEnvironments } = useProjectMembers({
    isAuthenticated,
    projectId:
      enabled && shouldQueryProjectId(normalizedProjectId)
        ? normalizedProjectId
        : null,
  });

  const hostNamesById = useMemo(
    () => new Map(hosts.map((host) => [host.hostId, host.name])),
    [hosts]
  );

  // Sandbox-image names for the card chips. ONE project-wide list query (the
  // documented row-data-only / no-N+1 budget) — the same resolve-by-find
  // precedent the eval run detail uses.
  //
  // Skipped entirely unless a LOADED row actually carries a pin: the chip is the
  // only consumer, so firing this for the empty/loading strip or a project whose
  // environments pin nothing would add a project-wide request that can never
  // render anything. Flag off skips it too. Once a pinned row appears the query
  // starts, and the raw-id fallback below covers the frame before it resolves.
  const computersEnabled = useComputersEnabled();
  const hasPinnedImage = (environments ?? []).some(
    (environment) => environment.computerEnvironmentId
  );
  const sandboxImages = useSandboxImages(
    enabled && computersEnabled && hasPinnedImage ? normalizedProjectId : null
  );
  const imageNamesById = useMemo(
    () =>
      new Map((sandboxImages ?? []).map((img) => [img.environmentId, img.name])),
    [sandboxImages]
  );

  // "Save as environment": capture what Connect is currently pointed at into a
  // seeded create draft on /environments. hostId is the ONLY sourced field —
  // Connect has no server-group concept (null = "the client's own picks",
  // which IS Connect's semantics) and no enabled-skills state. No previewed
  // host is fine too: the editor's own "Pick a client" guard handles it.
  const saveAsEnvironment = () => {
    if (!normalizedProjectId) return;
    saveEnvironmentDraftSeed(normalizedProjectId, {
      hostId: previewedHostId ?? null,
      ...(previewedHostId && hostNamesById.get(previewedHostId)
        ? { name: hostNamesById.get(previewedHostId)! }
        : {}),
      serverAttachmentId: null,
      skillSelection: null,
    });
    navigateApp(routePaths.environments);
  };

  if (!enabled || !normalizedProjectId) return null;
  // Loading renders nothing (no flicker); the EMPTY state now renders a
  // compact capture row instead of the old unconditional null — hiding the
  // strip at zero environments hid "Save as environment" exactly where it is
  // most needed. Still admin-only: for members an empty strip is pure noise.
  if (!environments) return null;
  if (environments.length === 0) {
    if (!canManageEnvironments) return null;
    return (
      <div
        className={cn(
          "flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-muted/15 p-3",
          className
        )}
        data-testid="connect-environments-strip-empty"
      >
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Layers className="size-3.5" aria-hidden />
          No environments yet — save your current client and servers as a
          reusable environment.
        </p>
        <span className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={saveAsEnvironment}
            data-testid="connect-environments-save-as"
          >
            <Plus className="mr-1 h-3 w-3" />
            Save as environment
          </Button>
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
        </span>
      </div>
    );
  }

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
        <span className="flex shrink-0 items-center gap-3">
          {canManageEnvironments ? (
            <Button
              variant="link"
              size="sm"
              className="h-auto shrink-0 p-0 text-xs"
              onClick={saveAsEnvironment}
              data-testid="connect-environments-save-as"
            >
              <Plus className="mr-1 h-3 w-3" />
              Save as environment
            </Button>
          ) : null}
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
        </span>
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
                {/* Image chip only when pinned AND the computers flag is on —
                    absence is semantic (default image), so unpinned rows show
                    nothing rather than a filler label. Deleted image ⇒
                    truncated raw id, never a silent blank. */}
                {computersEnabled && environment.computerEnvironmentId ? (
                  <span
                    title="Sandbox image for eval runs and published chatboxes in this environment — Playground and swarms don't use it yet."
                    data-testid={`connect-environment-image-${environment.environmentId}`}
                  >
                    {" · "}
                    {imageNamesById.get(environment.computerEnvironmentId) ??
                      `image ${environment.computerEnvironmentId.slice(0, 8)}…`}
                  </span>
                ) : null}
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
