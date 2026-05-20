import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronDown, ChevronRight, Loader2, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { cn } from "@/lib/utils";
import {
  type ProjectServerConfigDto,
  type ProjectServerConfigInput,
  type ProjectServerOverrideEntry,
  emptyProjectServerConfigInput,
} from "@/lib/project-server-config";
import type { ServerWithName } from "@/hooks/use-app-state";
import { ServerOverrideEditor } from "@/components/server-overrides/ServerOverrideEditor";

interface ProjectServersSectionProps {
  /** Convex project id. Null for guest/local projects with no v2 row yet. */
  convexProjectId: string | null;
  /**
   * Catalog of project servers, keyed by server id. The same prop
   * `ProjectDefaultClientConfigSection` already receives, so the
   * Project Settings tab doesn't need a second query.
   */
  projectServers: Record<string, ServerWithName>;
  /**
   * When false, the section renders read-only — checkboxes and override
   * inputs are disabled. Project Settings gates editing on
   * `canManageProjectSettings` and mirrors that here.
   */
  canManage: boolean;
}

/**
 * Single source of truth for which servers connect across every host in
 * the project, plus per-server connection overrides. Edits go to
 * `projectServerConfig.setConfig`, which atomically (a) updates the
 * control-plane storage (`projects.serverIds` + `projectServerRefs`),
 * and (b) fans out into every interactive host in the project so the
 * `hosts.hostConfigId` pointer reflects the new effective config.
 * Runtime keeps reading `hostConfig.serverIds` — auto-connect, the
 * effective-client resolver, etc. don't need to know this section
 * exists.
 *
 * Pinned chatboxes (P4) stay on their saved snapshot — edits here do
 * not retroactively change them. Explicit per-host edits via the
 * Client editor still re-pin linked chatboxes.
 */
export function ProjectServersSection({
  convexProjectId,
  projectServers,
  canManage,
}: ProjectServersSectionProps) {
  const dto = useQuery(
    "projectServerConfig:getConfig" as any,
    convexProjectId ? ({ projectId: convexProjectId } as any) : "skip",
  ) as ProjectServerConfigDto | null | undefined;

  const setConfig = useMutation(
    "projectServerConfig:setConfig" as any,
  ) as unknown as (args: {
    projectId: string;
    input: ProjectServerConfigInput;
  }) => Promise<ProjectServerConfigDto>;

  // Live editor state mirrors the ProjectDefaultClientConfigSection
  // pattern: `baseline` is what we last loaded/saved so we can compute
  // dirty state and reset cleanly.
  const [value, setValue] = useState<ProjectServerConfigInput | null>(null);
  const [baseline, setBaseline] = useState<ProjectServerConfigInput | null>(
    null,
  );
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Hydrate when the dto loads or changes server-side. Don't stomp
  // in-progress edits when the user has unsaved changes.
  useEffect(() => {
    if (dto === undefined) return;
    const next: ProjectServerConfigInput = dto
      ? { serverIds: dto.serverIds, overrides: dto.overrides }
      : emptyProjectServerConfigInput();
    setBaseline(next);
    setValue((current) => {
      if (current && baseline && !projectServerConfigsEqual(current, baseline)) {
        return current;
      }
      return next;
    });
    // intentionally omit `baseline` from deps so we use the just-captured
    // snapshot above without retriggering on our own setBaseline
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dto]);

  const isDirty = useMemo(
    () =>
      value !== null &&
      baseline !== null &&
      !projectServerConfigsEqual(value, baseline),
    [value, baseline],
  );

  const catalog = useMemo(() => {
    return Object.entries(projectServers)
      .map(([id, srv]) => {
        // `config.url` is typed as string in the SDK but the runtime value
        // is a URL instance (the Connect page also calls `.toString()` on
        // it — see server-card-utils.ts). Rendering the raw value crashes
        // React with "Objects are not valid as a React child".
        const rawUrl =
          (srv as { config?: { url?: unknown } }).config?.url ??
          (srv as { url?: unknown }).url ??
          null;
        const url =
          rawUrl == null
            ? null
            : typeof rawUrl === "string"
              ? rawUrl
              : String(rawUrl);
        return {
          id,
          name: srv.name ?? id,
          url,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [projectServers]);

  const setRequired = (serverId: string, checked: boolean) => {
    if (!canManage) return;
    setValue((prev) => {
      if (!prev) return prev;
      const nextIds = checked
        ? Array.from(new Set([...prev.serverIds, serverId]))
        : prev.serverIds.filter((id) => id !== serverId);
      const nextOverrides = { ...prev.overrides };
      // Drop the override entry when the server is removed — backend
      // rejects override keys that aren't in serverIds.
      if (!checked) delete nextOverrides[serverId];
      return { serverIds: nextIds, overrides: nextOverrides };
    });
  };

  const setOverride = (
    serverId: string,
    next: ProjectServerOverrideEntry | null,
  ) => {
    if (!canManage) return;
    setValue((prev) => {
      if (!prev) return prev;
      const overrides = { ...prev.overrides };
      if (next === null) delete overrides[serverId];
      else overrides[serverId] = next;
      return { ...prev, overrides };
    });
  };

  const handleSave = async () => {
    if (!convexProjectId || !value) return;
    setIsSaving(true);
    try {
      await setConfig({ projectId: convexProjectId, input: value });
      toast.success("Project servers updated");
      // dto will refresh via useQuery; effect above re-baselines.
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update project servers";
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    if (!baseline) return;
    setValue(baseline);
  };

  // Loading / not-yet-eligible state.
  if (!convexProjectId) {
    return (
      <section className="space-y-2">
        <SectionHeading
          dirty={false}
          onSave={() => undefined}
          onReset={() => undefined}
          canManage={false}
          disabled
        />
        <p className="text-xs text-muted-foreground">
          Project servers require an authenticated project.
        </p>
      </section>
    );
  }
  if (value === null) {
    return (
      <section className="space-y-2">
        <SectionHeading
          dirty={false}
          onSave={() => undefined}
          onReset={() => undefined}
          canManage={canManage}
          disabled
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Loading project server config…
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <SectionHeading
        dirty={isDirty}
        onSave={handleSave}
        onReset={handleReset}
        canManage={canManage}
        disabled={!canManage || isSaving}
        saving={isSaving}
      />

      {catalog.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No servers in this project yet — add one from the Servers tab.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {catalog.map((srv) => {
            const isRequired = value.serverIds.includes(srv.id);
            const override = value.overrides[srv.id];
            const expanded = expandedServerId === srv.id;
            const overrideCount =
              (override?.headersOverride &&
              Object.keys(override.headersOverride).length > 0
                ? 1
                : 0) +
              (override?.requestTimeoutOverride !== undefined ? 1 : 0);

            return (
              <div
                key={srv.id}
                className={cn(
                  "rounded-md border bg-card/60",
                  expanded ? "border-border" : "border-border/60",
                )}
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  <Checkbox
                    checked={isRequired}
                    disabled={!canManage || isSaving}
                    onCheckedChange={(c) => setRequired(srv.id, !!c)}
                    aria-label={`Auto-connect ${srv.name} for every host in this project`}
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span
                      className="truncate text-[12.5px] font-semibold"
                      title={srv.name}
                    >
                      {srv.name}
                    </span>
                    <span
                      className="truncate font-mono text-[10.5px] text-muted-foreground"
                      title={srv.url ?? "Project server"}
                    >
                      {srv.url ?? "Project server"}
                    </span>
                  </div>
                  {overrideCount > 0 ? (
                    <Badge
                      variant="outline"
                      className="border-amber-500/50 bg-amber-500/10 px-1.5 py-0 text-[9.5px] text-amber-800 dark:text-amber-300"
                    >
                      {overrideCount}{" "}
                      {overrideCount === 1 ? "override" : "overrides"}
                    </Badge>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground"
                    onClick={() =>
                      setExpandedServerId(expanded ? null : srv.id)
                    }
                    aria-label={expanded ? "Collapse" : "Expand"}
                  >
                    {expanded ? (
                      <ChevronDown className="size-3" />
                    ) : (
                      <ChevronRight className="size-3" />
                    )}
                  </Button>
                </div>
                {expanded ? (
                  <ServerOverrideEditor
                    override={override}
                    disabled={!canManage || isSaving}
                    onChange={(next) => setOverride(srv.id, next)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SectionHeading({
  dirty,
  saving,
  onSave,
  onReset,
  canManage,
  disabled,
}: {
  dirty: boolean;
  saving?: boolean;
  onSave: () => void;
  onReset: () => void;
  canManage: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex flex-col">
        <h2 className="text-sm font-medium text-muted-foreground">Servers</h2>
        <p className="text-[11px] text-muted-foreground">
          Choose which servers auto-connect for every host in this project.
          Headers and timeout overrides apply project-wide. Pinned chatboxes
          keep their current settings.
        </p>
      </div>
      {canManage ? (
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!dirty || disabled}
            onClick={onReset}
            className="h-7 gap-1 text-[11px]"
          >
            <RotateCcw className="size-3" />
            Reset
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || disabled}
            onClick={onSave}
            className="h-7 gap-1 text-[11px]"
          >
            {saving ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Save className="size-3" />
            )}
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function projectServerConfigsEqual(
  a: ProjectServerConfigInput,
  b: ProjectServerConfigInput,
): boolean {
  if (a === b) return true;
  if (a.serverIds.length !== b.serverIds.length) return false;
  const aIds = [...a.serverIds].sort();
  const bIds = [...b.serverIds].sort();
  for (let i = 0; i < aIds.length; i++) {
    if (aIds[i] !== bIds[i]) return false;
  }
  const aKeys = Object.keys(a.overrides).sort();
  const bKeys = Object.keys(b.overrides).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    const av = a.overrides[aKeys[i]];
    const bv = b.overrides[aKeys[i]];
    if (av.requestTimeoutOverride !== bv.requestTimeoutOverride) return false;
    if (!headersEqual(av.headersOverride, bv.headersOverride)) return false;
  }
  return true;
}

function headersEqual(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
