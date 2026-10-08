import { useCallback, useEffect, useMemo, useState } from "react";
import { useConvexAuth } from "convex/react";
import { Copy, Settings2, SquareSlash } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { buildProjectPluginPath, useAppNavigate } from "@/lib/app-navigation";
import type { ActivePluginRow } from "@/lib/plugins/active-plugins-types";
import type { PluginSummary } from "@/lib/plugins/plugin-api-types";
import { useActivePlugins, pluginLabel } from "@/hooks/useActivePlugins";
import {
  useDetachPluginSkill,
  usePluginVersion,
  useProjectPlugins,
} from "@/hooks/usePluginImportApi";
import { useProjectMembers } from "@/hooks/useProjects";
import { useSoftQuery } from "@/hooks/use-soft-query";
import { PluginSettingsSection } from "@/components/plugins/PluginSettingsSection";
import { PLUGIN_DETACH_ADMIN_ONLY_REASON } from "@/components/plugins/plugin-status";
import { SkillFileViewer } from "./SkillFileViewer";

/** A plugin skill opened in the Skills tab. */
export interface PluginSkillSelection {
  pluginId: string;
  pluginLabel: string;
  /** The materialized `projectSkills` row. */
  skillId: string;
  modelRef: string;
  name: string;
  description: string;
}

interface PluginSkillRowData extends PluginSkillSelection {
  key: string;
}

function toSelection({ key: _key, ...selection }: PluginSkillRowData) {
  return selection;
}

function rowsFromActive(
  plugin: PluginSummary,
  row: ActivePluginRow,
): PluginSkillRowData[] {
  const label = pluginLabel(row);
  return row.skills.map((skill) => ({
    key: `${plugin.pluginId}:${skill.skillId}`,
    pluginId: plugin.pluginId,
    pluginLabel: label,
    skillId: skill.skillId,
    modelRef: skill.modelRef,
    name: skill.name,
    description: skill.description,
  }));
}

/**
 * Plugin skills as one more source in the Skills tab, beside Local, Library
 * and the connected servers' skills. Each row carries its plugin, so where a
 * skill comes from travels with it. Read-only: a plugin's skills belong to its
 * version.
 *
 * Listed from the active-plugins read (every installed plugin, contributing or
 * skipped, with its active version's skills); a plugin that read has no row
 * for yet falls back to its version's components.
 *
 * `onListingChange` reports every row it shows, the fallback ones included,
 * and stays `pending` while a fallback version has not answered, so the tab
 * never says "No skills" beside skills it is still listing.
 */
export function PluginSkillsSection({
  projectId,
  selectedSkillId,
  focusPluginId = null,
  onOpenSkill,
  onListingChange,
}: {
  projectId: string;
  selectedSkillId: string | null;
  /** A `?plugin=` permalink: open this plugin's first skill once listed. */
  focusPluginId?: string | null;
  onOpenSkill: (skill: PluginSkillSelection) => void;
  onListingChange?: (listing: { count: number; pending: boolean }) => void;
}) {
  const installed = useProjectPlugins(projectId);
  const { plugins: activeRows } = useActivePlugins(projectId);
  const plugins = useMemo(() => installed ?? [], [installed]);
  const rows = useMemo(
    () =>
      plugins.flatMap((plugin) => {
        const row = activeRows.find((r) => r.pluginId === plugin.pluginId);
        return row ? rowsFromActive(plugin, row) : [];
      }),
    [plugins, activeRows],
  );
  const fallbackPlugins = plugins.filter(
    (plugin) =>
      plugin.activeVersionId &&
      !activeRows.some((row) => row.pluginId === plugin.pluginId),
  );

  // What each fallback plugin's version lists, once that version answered.
  const [fallbackCounts, setFallbackCounts] = useState<
    Record<string, number | undefined>
  >({});
  const reportFallback = useCallback(
    (pluginId: string, count: number | undefined) =>
      setFallbackCounts((previous) =>
        previous[pluginId] === count
          ? previous
          : { ...previous, [pluginId]: count },
      ),
    [],
  );
  const fallbackCount = fallbackPlugins.reduce(
    (total, plugin) => total + (fallbackCounts[plugin.pluginId] ?? 0),
    0,
  );
  const fallbackPending = fallbackPlugins.some(
    (plugin) => fallbackCounts[plugin.pluginId] === undefined,
  );
  const count = rows.length + fallbackCount;

  useEffect(() => {
    onListingChange?.({ count, pending: fallbackPending });
  }, [count, fallbackPending, onListingChange]);

  const [focusHandled, setFocusHandled] = useState(false);
  useEffect(() => {
    if (!focusPluginId || focusHandled) return;
    const first = rows.find((row) => row.pluginId === focusPluginId);
    if (!first) return;
    setFocusHandled(true);
    onOpenSkill(toSelection(first));
  }, [focusPluginId, focusHandled, rows, onOpenSkill]);

  if (rows.length === 0 && fallbackPlugins.length === 0) return null;
  return (
    <div data-testid="plugin-skills-section">
      {rows.map((row) => (
        <PluginSkillRow
          key={row.key}
          row={row}
          selected={row.skillId === selectedSkillId}
          onOpen={() => onOpenSkill(toSelection(row))}
        />
      ))}
      {fallbackPlugins.map((plugin) => (
        <PluginVersionSkillRows
          key={plugin.pluginId}
          plugin={plugin}
          selectedSkillId={selectedSkillId}
          onOpenSkill={onOpenSkill}
          onCount={reportFallback}
        />
      ))}
    </div>
  );
}

function PluginVersionSkillRows({
  plugin,
  selectedSkillId,
  onOpenSkill,
  onCount,
}: {
  plugin: PluginSummary;
  selectedSkillId: string | null;
  onOpenSkill: (skill: PluginSkillSelection) => void;
  /** How many rows this lists; `undefined` until the version answers. */
  onCount: (pluginId: string, count: number | undefined) => void;
}) {
  const version = usePluginVersion(plugin.activeVersionId ?? null);
  const label = plugin.displayName || plugin.name;
  const listed = version
    ? version.skills.filter((component) => component.materializedSkillId).length
    : undefined;
  useEffect(() => {
    onCount(plugin.pluginId, listed);
  }, [plugin.pluginId, listed, onCount]);
  return (
    <>
      {(version?.skills ?? []).flatMap((component) =>
        component.materializedSkillId
          ? [
              <PluginSkillRow
                key={component.componentId}
                row={{
                  key: component.componentId,
                  pluginId: plugin.pluginId,
                  pluginLabel: label,
                  skillId: component.materializedSkillId,
                  modelRef: component.modelRef,
                  name: component.declaredName,
                  description: "",
                }}
                selected={component.materializedSkillId === selectedSkillId}
                onOpen={() =>
                  onOpenSkill({
                    pluginId: plugin.pluginId,
                    pluginLabel: label,
                    skillId: component.materializedSkillId!,
                    modelRef: component.modelRef,
                    name: component.declaredName,
                    description: "",
                  })
                }
              />,
            ]
          : [],
      )}
    </>
  );
}

function PluginSkillRow({
  row,
  selected,
  onOpen,
}: {
  row: PluginSkillRowData;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={row.modelRef}
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs transition-colors",
        selected ? "bg-primary/10 text-primary" : "hover:bg-muted/50",
      )}
      data-testid="plugin-skill-row"
    >
      <SquareSlash className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
      <span
        className={cn("truncate font-medium", selected && "text-foreground")}
      >
        {row.name}
      </span>
      <Badge
        variant="secondary"
        className="ml-auto flex-shrink-0 text-[10px] font-normal"
      >
        Plugin · {row.pluginLabel}
      </Badge>
    </button>
  );
}

/**
 * A plugin skill's read-only detail: its SKILL.md, a way to its plugin's
 * Settings, and Detach as copy (an editable personal copy; the plugin's own
 * skill is untouched). A plugin with no servers keeps its Plugin section here,
 * since there is no server Settings to hold it.
 */
export function PluginSkillDetail({
  projectId,
  skill,
  onDetached,
  onUninstalled,
}: {
  projectId: string;
  skill: PluginSkillSelection;
  /** A detached copy now exists in the project store. */
  onDetached?: () => void;
  /**
   * The plugin was uninstalled from the Plugin section here (a plugin with
   * no servers has no other one), so this skill is gone with it.
   */
  onUninstalled?: () => void;
}) {
  const navigate = useAppNavigate();
  const installed = useProjectPlugins(projectId);
  const plugin = installed?.find((p) => p.pluginId === skill.pluginId);
  const version = usePluginVersion(plugin?.activeVersionId ?? null);
  const { plugins: activeRows } = useActivePlugins(projectId);
  const row = activeRows.find((r) => r.pluginId === skill.pluginId);
  const hasServers = version
    ? version.servers.length > 0
    : (row?.servers.length ?? 0) > 0;
  const component = version?.skills.find(
    (candidate) =>
      candidate.materializedSkillId === skill.skillId ||
      candidate.modelRef === skill.modelRef,
  );
  const { isAuthenticated } = useConvexAuth();
  const { canManageMembers, isLoading: membersLoading } = useProjectMembers({
    isAuthenticated,
    projectId,
  });
  const canManage = canManageMembers === true;
  const [showPlugin, setShowPlugin] = useState(false);
  const [detachOpen, setDetachOpen] = useState(false);

  const { data, error } = useSoftQuery<{ content?: string }>(
    "projectSkills:getSkill",
    { projectId, skillId: skill.skillId },
  );
  const file = data
    ? {
        path: "SKILL.md",
        name: skill.name,
        content: data.content ?? "",
        mimeType: "text/markdown",
        size: (data.content ?? "").length,
        isText: true,
      }
    : null;

  return (
    <div className="flex h-full flex-col" data-testid="plugin-skill-detail">
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {skill.name}
            </span>
            <Badge
              variant="secondary"
              className="flex-shrink-0 text-[10px] tracking-wide"
            >
              Plugin · {skill.pluginLabel}
            </Badge>
            <span
              className="truncate font-mono text-xs text-muted-foreground/60"
              title={skill.modelRef}
            >
              {skill.modelRef}
            </span>
          </div>
          {skill.description ? (
            <p className="line-clamp-1 text-xs text-muted-foreground">
              {skill.description}
            </p>
          ) : null}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={hasServers ? undefined : showPlugin}
            onClick={() => {
              if (hasServers) {
                navigate(buildProjectPluginPath(skill.pluginId));
              } else {
                setShowPlugin((open) => !open);
              }
            }}
            data-testid="plugin-skill-open-plugin"
          >
            <Settings2 className="mr-1 h-3.5 w-3.5" />
            Plugin settings
          </Button>
          {/* The reason rides on a wrapper: a disabled button gets no hover. */}
          <span
            title={
              !canManage && !membersLoading
                ? PLUGIN_DETACH_ADMIN_ONLY_REASON
                : "Make an editable personal copy"
            }
            data-testid="plugin-skill-detach-wrapper"
          >
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs text-muted-foreground hover:text-foreground"
              disabled={!canManage || !component}
              onClick={() => setDetachOpen(true)}
              data-testid="plugin-skill-detach"
            >
              <Copy className="mr-1 h-3.5 w-3.5" />
              Detach as copy
            </Button>
          </span>
        </div>
      </div>
      {showPlugin && !hasServers ? (
        <div className="border-b border-border px-4 py-3">
          <PluginSettingsSection
            projectId={projectId}
            pluginId={skill.pluginId}
            onUninstalled={onUninstalled}
          />
        </div>
      ) : null}
      <div className="flex-1 overflow-hidden">
        <SkillFileViewer
          file={file}
          loading={!data && !error}
          error={error ? "This skill couldn't be loaded." : ""}
          rawMode={false}
        />
      </div>
      {component ? (
        <DetachSkillDialog
          open={detachOpen}
          onOpenChange={setDetachOpen}
          componentId={component.componentId}
          defaultName={skill.name}
          onDetached={onDetached}
        />
      ) : null}
    </div>
  );
}

function DetachSkillDialog({
  open,
  onOpenChange,
  componentId,
  defaultName,
  onDetached,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  componentId: string;
  defaultName: string;
  onDetached?: () => void;
}) {
  const detach = useDetachPluginSkill();
  const [name, setName] = useState(defaultName);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);
  const trimmed = name.trim();
  const submit = async () => {
    if (!trimmed) return;
    setPending(true);
    try {
      await detach(componentId, trimmed);
      toast.success(`Detached as “${trimmed}”. It's in your skills now.`);
      onOpenChange(false);
      onDetached?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not detach the skill.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Detach as copy</DialogTitle>
          <DialogDescription>
            Makes an editable personal copy. The plugin's own skill stays as it
            is.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="detach-skill-name">Name</Label>
          <Input
            id="detach-skill-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={pending || !trimmed}
            data-testid="plugin-skill-detach-confirm"
          >
            Detach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
