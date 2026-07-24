import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  Layers,
  Loader2,
  Plus,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { routePaths } from "@/lib/app-navigation";
import { convexErrMessage } from "@/lib/convex-error";
import { useProjectEnvironmentsEnabledState } from "@/hooks/useProjectEnvironmentsEnabled";
import {
  useArchiveProjectEnvironment,
  useProjectEnvironments,
  useRestoreProjectEnvironment,
  type ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import { ProjectEnvironmentEditor } from "./ProjectEnvironmentEditor";
import { useProjectEnvironmentConsumers } from "./use-project-environment-consumers";

/**
 * Full-page list⇄detail management screen for Project environments — named
 * host + server group + pinned-skills bundles that suites and journeys run
 * against. Flag-gated INSIDE the component so a direct `/environments` URL
 * cannot bypass the sidebar gate.
 */
export function ProjectEnvironmentsRoute({
  projectId,
  canManage,
}: {
  projectId: string | null;
  /** Admin-gated writes; members browse read-only. */
  canManage: boolean;
}) {
  const flagEnabled = useProjectEnvironmentsEnabledState();

  const environments = useProjectEnvironments(
    flagEnabled === true ? projectId : null,
    { includeArchived: true }
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // A just-created env, kept until the reactive list query includes it — so
  // we land on its detail immediately instead of bouncing back to the list.
  const [justCreated, setJustCreated] = useState<ProjectEnvironmentView | null>(
    null
  );

  useEffect(() => {
    if (!justCreated) return;
    if (
      environments?.some((e) => e.environmentId === justCreated.environmentId)
    ) {
      setJustCreated(null);
      return;
    }
    const t = setTimeout(() => setJustCreated(null), 3000);
    return () => clearTimeout(t);
  }, [justCreated, environments]);

  const selected = useMemo(
    () =>
      environments?.find((e) => e.environmentId === selectedId) ??
      (justCreated?.environmentId === selectedId ? justCreated : null),
    [environments, selectedId, justCreated]
  );

  // Only redirect on an explicit `false`. While PostHog hydrates the flag is
  // `undefined`; bouncing then would strand a flagged-in user who cold-loads
  // /environments directly. Render nothing until it settles.
  if (flagEnabled === false) {
    return <Navigate to={routePaths.servers} replace />;
  }
  if (flagEnabled === undefined) {
    return null;
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a project to manage its environments.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        {creating ? (
          <div className="space-y-4">
            <BackLink
              label="All environments"
              onClick={() => setCreating(false)}
            />
            <h1 className="text-lg font-semibold text-foreground">
              New environment
            </h1>
            <ProjectEnvironmentEditor
              projectId={projectId}
              environment={null}
              canManage={canManage}
              onCreated={(env) => {
                setCreating(false);
                setJustCreated(env);
                setSelectedId(env.environmentId);
              }}
              onCancelCreate={() => setCreating(false)}
            />
          </div>
        ) : selected ? (
          <EnvironmentDetail
            key={`${selected.environmentId}:${selected.archivedAt ?? "live"}`}
            projectId={projectId}
            environment={selected}
            canManage={canManage}
            onBack={() => setSelectedId(null)}
          />
        ) : (
          <EnvironmentList
            environments={environments}
            canManage={canManage}
            onSelect={setSelectedId}
            onNew={() => setCreating(true)}
          />
        )}
      </div>
    </div>
  );
}

function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" /> {label}
    </button>
  );
}

function EnvironmentList({
  environments,
  canManage,
  onSelect,
  onNew,
}: {
  environments: ProjectEnvironmentView[] | undefined;
  canManage: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  if (environments === undefined) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading environments…
      </div>
    );
  }
  const live = environments.filter((e) => !e.archivedAt);
  const archived = environments.filter((e) => !!e.archivedAt);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">
            Environments
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            A named bundle of one client, an optional server group, and optional
            pinned skills. Suites and journeys run against environments and
            resolve them at launch.
          </p>
        </div>
        {canManage ? (
          <Button size="sm" onClick={onNew}>
            <Plus className="mr-1.5 size-3.5" /> New environment
          </Button>
        ) : null}
      </div>

      {live.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          <Layers className="mx-auto mb-2 size-5" />
          No environments yet
          {canManage ? " — create one to get started." : "."}
        </div>
      ) : (
        <div className="divide-y divide-border/60 rounded-md border">
          {live.map((env) => (
            <EnvironmentRow
              key={env.environmentId}
              env={env}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      {archived.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
            Archived
          </h2>
          <div className="divide-y divide-border/60 rounded-md border">
            {archived.map((env) => (
              <EnvironmentRow
                key={env.environmentId}
                env={env}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EnvironmentRow({
  env,
  onSelect,
}: {
  env: ProjectEnvironmentView;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(env.environmentId)}
      className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">{env.name}</span>
        {env.description ? (
          <span className="truncate text-xs text-muted-foreground">
            {env.description}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {env.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
        <span className="font-mono text-[10px] text-muted-foreground">
          rev {env.revision}
        </span>
      </span>
    </button>
  );
}

function EnvironmentDetail({
  projectId,
  environment,
  canManage,
  onBack,
}: {
  projectId: string;
  environment: ProjectEnvironmentView;
  canManage: boolean;
  onBack: () => void;
}) {
  const archiveEnvironment = useArchiveProjectEnvironment();
  const restoreEnvironment = useRestoreProjectEnvironment();
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const { suiteCount } = useProjectEnvironmentConsumers(
    projectId,
    confirmingArchive ? environment.environmentId : null
  );

  const isArchived = !!environment.archivedAt;

  const onArchive = async () => {
    setBusy(true);
    try {
      // Archive is actioned on the row as currently shown (no draft), so the
      // reactive revision IS the base revision here.
      await archiveEnvironment({
        environmentId: environment.environmentId,
        expectedRevision: environment.revision,
      });
      toast.success(`Archived “${environment.name}”.`);
      setConfirmingArchive(false);
    } catch (err) {
      toast.error(convexErrMessage(err, "Could not archive the environment."));
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async () => {
    setBusy(true);
    try {
      await restoreEnvironment({
        environmentId: environment.environmentId,
        expectedRevision: environment.revision,
      });
      toast.success(`Restored “${environment.name}”.`);
    } catch (err) {
      toast.error(convexErrMessage(err, "Could not restore the environment."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <BackLink label="All environments" onClick={onBack} />
        <span className="flex items-center gap-2">
          {isArchived ? <Badge variant="outline">Archived</Badge> : null}
          <span className="font-mono text-[10px] text-muted-foreground">
            rev {environment.revision}
          </span>
        </span>
      </div>

      {isArchived ? (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            Archived — hidden from pickers; suites and journeys still
            referencing it fail fast at their next launch.
          </p>
          {canManage ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-xs"
              disabled={busy}
              onClick={() => void onRestore()}
            >
              <ArchiveRestore className="mr-1.5 size-3.5" /> Restore
            </Button>
          ) : null}
        </div>
      ) : null}

      <ProjectEnvironmentEditor
        projectId={projectId}
        environment={environment}
        canManage={canManage && !isArchived}
      />

      {canManage && !isArchived ? (
        <div className="flex items-center justify-between border-t pt-4">
          {confirmingArchive ? (
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                Archive “{environment.name}”?{" "}
                {suiteCount === null
                  ? "Checking references…"
                  : suiteCount > 0
                  ? `${suiteCount} suite${
                      suiteCount === 1 ? "" : "s"
                    } reference it (count may be incomplete — journeys aren't scanned).`
                  : "No referencing suites found (count may be incomplete — journeys aren't scanned)."}{" "}
                Referencing runs fail fast at their next launch.
              </span>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => void onArchive()}
              >
                {busy ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : null}
                Archive
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => setConfirmingArchive(false)}
              >
                Cancel
              </Button>
            </span>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmingArchive(true)}
            >
              <Archive className="mr-1.5 size-3.5" /> Archive
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
