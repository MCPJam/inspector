import { useMemo, useState } from "react";
import { useConvexAuth } from "convex/react";
import { Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import { SettingsSection } from "@/components/setting/SettingsSection";
import {
  useOrgSlackSettings,
  type SurfaceKind,
} from "@/hooks/useOrgSlackSettings";
import { useProjectQueries } from "@/hooks/useProjects";

/**
 * Connections: the workspaces/servers this org uses, its org-wide default
 * project, and its channel→project bindings.
 *
 * THE #1 FRICTION REMOVER. Without it every member has to pick a default
 * project individually before the bot is useful to them; the two controls here
 * remove that step for a whole tenant (org default) or a whole channel
 * (binding).
 *
 * PRECEDENCE IS STATED, NOT IMPLIED. Admins asked to configure two defaults
 * will assume the org one wins, and it does not — a member's own choice always
 * does. The copy says so next to the control rather than in docs nobody opens.
 *
 * SURFACE-NEUTRAL. This was Slack's tab; Discord needs the same three
 * controls over the same tables, so it is parameterized rather than copied.
 * Everything that genuinely differs between the two is a string in
 * `SURFACE_COPY` below plus one capability flag — which is also the honest
 * inventory of how the surfaces diverge, in one readable place instead of
 * spread across two 400-line files that would drift.
 */

const NONE_VALUE = "__none__";

interface SurfaceCopy {
  /** "workspace" / "server", lowercase, singular. */
  tenantNoun: string;
  tenantNounPlural: string;
  /** Column header and picker label. */
  tenantLabel: string;
  emptyTenants: string;
  notInstalled: string;
  channelIdHint: string;
  channelIdPlaceholder: string;
  /**
   * Slack only. `surfaceNotificationsNode` delivers through Slack's
   * `chat.postMessage` and has no Discord path at all, so offering the button
   * on a Discord binding would queue a job that can only fail — and fail in a
   * way that reads as the binding being broken.
   */
  supportsTestNotifications: boolean;
}

const SURFACE_COPY: Record<SurfaceKind, SurfaceCopy> = {
  slack: {
    tenantNoun: "workspace",
    tenantNounPlural: "workspaces",
    tenantLabel: "Workspace",
    emptyTenants:
      "No Slack workspaces yet. A workspace appears here once someone in this organization connects their MCPJam account from the MCPJam Slack app.",
    notInstalled: "MCPJam is not installed in this workspace",
    channelIdHint:
      "A channel can be bound to one project. Copy the channel ID from Slack (channel name → About → the ID at the bottom).",
    channelIdPlaceholder: "C01234567",
    supportsTestNotifications: true,
  },
  discord: {
    tenantNoun: "server",
    tenantNounPlural: "servers",
    tenantLabel: "Server",
    emptyTenants:
      "No Discord servers yet. A server appears here once someone in this organization runs /mcpjam connect in a server the bot has been added to.",
    notInstalled: "MCPJam is not in this server",
    channelIdHint:
      "A channel can be bound to one project. Turn on Developer Mode in Discord (Settings → Advanced), then right-click the channel → Copy Channel ID.",
    channelIdPlaceholder: "123456789012345678",
    supportsTestNotifications: false,
  },
};

interface SurfaceConnectionsTabProps {
  organizationId: string;
  isAdmin: boolean;
  surfaceKind: SurfaceKind;
}

export function SurfaceConnectionsTab({
  organizationId,
  isAdmin,
  surfaceKind,
}: SurfaceConnectionsTabProps) {
  const copy = SURFACE_COPY[surfaceKind];
  const { isAuthenticated } = useConvexAuth();
  const {
    connections,
    isLoading,
    error,
    isSaving,
    setOrgDefaultProject,
    createChannelBinding,
    removeChannelBinding,
    sendTestNotification,
  } = useOrgSlackSettings(organizationId, surfaceKind);
  const { sortedProjects } = useProjectQueries({
    isAuthenticated,
    organizationId,
  });

  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of sortedProjects) map.set(project._id, project.name);
    return map;
  }, [sortedProjects]);

  const workspaces = connections?.workspaces ?? [];
  const bindings = connections?.channelBindings ?? [];

  const [newBinding, setNewBinding] = useState({
    surfaceTenantId: "",
    channelId: "",
    projectId: "",
  });

  const canAddBinding =
    isAdmin &&
    Boolean(newBinding.surfaceTenantId) &&
    Boolean(newBinding.channelId.trim()) &&
    Boolean(newBinding.projectId);

  const handleAddBinding = async () => {
    if (!canAddBinding) return;
    try {
      await createChannelBinding({
        surfaceTenantId: newBinding.surfaceTenantId,
        channelId: newBinding.channelId.trim(),
        projectId: newBinding.projectId,
      });
      setNewBinding((previous) => ({ ...previous, channelId: "" }));
    } catch {
      // The hook surfaces the message; the form keeps what the admin typed so
      // a conflict does not cost them the entry.
    }
  };

  const projectLabel = (projectId: string | null) =>
    projectId ? projectNameById.get(projectId) ?? projectId : "—";

  return (
    <div className="space-y-8">
      {error ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <SettingsSection title={`Connected ${copy.tenantNounPlural}`}>
        {isLoading ? (
          <div className="px-4 py-8 text-sm text-muted-foreground">
            Loading…
          </div>
        ) : workspaces.length === 0 ? (
          <div className="space-y-2 px-4 py-8 text-sm text-muted-foreground">
            <p>{copy.emptyTenants}</p>
          </div>
        ) : (
          workspaces.map((workspace) => (
            <div
              key={workspace.surfaceTenantId}
              className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-border/40 bg-muted/20 px-4 py-3"
              data-testid={`${surfaceKind}-workspace-${workspace.surfaceTenantId}`}
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">
                  {workspace.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {workspace.installed
                    ? `${workspace.linkedMemberCount} connected ${
                        workspace.linkedMemberCount === 1 ? "member" : "members"
                      }`
                    : // Worth saying out loud: the org's members are using a
                      // tenant where the app is not installed, which is why
                      // the bot does not answer them.
                      copy.notInstalled}
                </span>
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <label
                  className="text-xs text-muted-foreground"
                  htmlFor={`org-default-${workspace.surfaceTenantId}`}
                >
                  Default project
                </label>
                <Select
                  value={workspace.defaultProjectId ?? NONE_VALUE}
                  disabled={!isAdmin || isSaving}
                  onValueChange={(value) =>
                    void setOrgDefaultProject({
                      surfaceTenantId: workspace.surfaceTenantId,
                      ...(value === NONE_VALUE ? {} : { projectId: value }),
                    }).catch(() => {})
                  }
                >
                  <SelectTrigger
                    id={`org-default-${workspace.surfaceTenantId}`}
                    className="w-56"
                    aria-label={`Default project for ${workspace.name}`}
                  >
                    <SelectValue placeholder="No default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_VALUE}>No default</SelectItem>
                    {sortedProjects.map((project) => (
                      <SelectItem key={project._id} value={project._id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ))
        )}
        <p className="px-4 pt-2 text-xs text-muted-foreground">
          The organization default is a fallback for people who have not picked
          a project of their own — it never overrides an individual&apos;s
          choice. A bound channel and an engaged thread both take precedence
          over it.
        </p>
      </SettingsSection>

      <SettingsSection title="Channel bindings">
        {isLoading ? (
          // Guarded like "Connected …" above: `bindings` falls back to `[]`
          // while the query is in flight, so without this the section claims
          // "no channels bound" and then contradicts itself.
          <div className="px-4 py-6 text-sm text-muted-foreground">
            Loading…
          </div>
        ) : bindings.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            No channels bound yet. A bound channel sends every turn started
            there to one project, whoever is speaking.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{copy.tenantLabel}</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Project</TableHead>
                  {copy.supportsTestNotifications ? (
                    <TableHead>Notifications</TableHead>
                  ) : null}
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {bindings.map((binding) => {
                  // `not_in_channel` is the expected day-one failure: the bot
                  // has no `chat:write.public`/`channels:read`, so it can
                  // only post somewhere it was explicitly invited.
                  const needsInvite =
                    binding.lastTestStatus === "failure" &&
                    binding.lastTestError === "not_in_channel";
                  return (
                    <TableRow
                      key={binding._id}
                      data-testid={`${surfaceKind}-binding-${binding.channelId}`}
                    >
                      <TableCell className="text-sm">
                        {workspaces.find(
                          (workspace) =>
                            workspace.surfaceTenantId ===
                            binding.surfaceTenantId
                        )?.name ?? binding.surfaceTenantId}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {binding.channelId}
                      </TableCell>
                      <TableCell className="text-sm">
                        {projectLabel(binding.projectId)}
                      </TableCell>
                      {copy.supportsTestNotifications ? (
                        <TableCell className="text-sm">
                          <div className="flex flex-col gap-1">
                            {isAdmin ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={isSaving}
                                onClick={() =>
                                  void sendTestNotification(binding._id).catch(
                                    () => {}
                                  )
                                }
                              >
                                Send test notification
                              </Button>
                            ) : null}
                            {needsInvite ? (
                              <span className="text-xs text-destructive">
                                Invite @MCPJam to this channel, then try again.
                              </span>
                            ) : binding.lastTestStatus === "failure" ? (
                              <span className="text-xs text-destructive">
                                {binding.lastTestError ?? "Test failed."}
                              </span>
                            ) : binding.lastTestStatus === "success" ? (
                              <span className="text-xs text-muted-foreground">
                                Test delivered.
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                      ) : null}
                      <TableCell>
                        {isAdmin ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={isSaving}
                            aria-label={`Remove binding for ${binding.channelId}`}
                            onClick={() =>
                              void removeChannelBinding(binding._id).catch(
                                () => {}
                              )
                            }
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SettingsSection>

      {isAdmin ? (
        <SettingsSection title="Bind a channel">
          <div className="flex flex-wrap items-end gap-3 px-4 py-3">
            <div className="flex flex-col gap-1">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="binding-workspace"
              >
                {copy.tenantLabel}
              </label>
              <Select
                value={newBinding.surfaceTenantId}
                onValueChange={(value) =>
                  setNewBinding((previous) => ({
                    ...previous,
                    surfaceTenantId: value,
                  }))
                }
              >
                <SelectTrigger
                  id="binding-workspace"
                  className="w-52"
                  aria-label={copy.tenantLabel}
                >
                  <SelectValue
                    placeholder={`Select a ${copy.tenantNoun}`}
                  />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((workspace) => (
                    <SelectItem
                      key={workspace.surfaceTenantId}
                      value={workspace.surfaceTenantId}
                    >
                      {workspace.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="binding-channel"
              >
                Channel ID
              </label>
              <Input
                id="binding-channel"
                className="w-52"
                placeholder={copy.channelIdPlaceholder}
                value={newBinding.channelId}
                onChange={(event) =>
                  setNewBinding((previous) => ({
                    ...previous,
                    channelId: event.target.value,
                  }))
                }
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="binding-project"
              >
                Project
              </label>
              <Select
                value={newBinding.projectId}
                onValueChange={(value) =>
                  setNewBinding((previous) => ({
                    ...previous,
                    projectId: value,
                  }))
                }
              >
                <SelectTrigger
                  id="binding-project"
                  className="w-52"
                  aria-label="Project"
                >
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {sortedProjects.map((project) => (
                    <SelectItem key={project._id} value={project._id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              disabled={!canAddBinding || isSaving}
              onClick={() => void handleAddBinding()}
            >
              Bind channel
            </Button>
          </div>
          <p className="px-4 pb-3 text-xs text-muted-foreground">
            {copy.channelIdHint}
          </p>
        </SettingsSection>
      ) : null}
    </div>
  );
}
