/**
 * Swarms → Clients sub-tab: product-scoped host management.
 *
 * Hosts are a product-neutral substrate. This panel lets the Swarms surface
 * create and configure its OWN clients WITHOUT minting a Chatbox/publish
 * surface (standalone `owner: 'journeys'` hosts), and reuses the same
 * product-neutral editor (deep-link into Connect) and server-group picker as
 * every other host surface.
 *
 * Create / edit / apply-group / delete are ADMIN-gated server-side, so every
 * mutating affordance here is hidden for non-admins (`canManage`). A member
 * can still view clients and run journeys.
 */
import { useMemo, useState } from "react";
import { Boxes, Cpu, Loader2, Pencil, Plus, Server, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import {
  useHost,
  useHostList,
  useHostMutations,
  type HostListItem,
} from "@/hooks/useClients";
import {
  ServerGroupPicker,
  type ServerGroup,
} from "@/components/hosts/ServerGroupPicker";
import { CreateHostDialog } from "@/components/hosts/CreateHostDialog";
import { hostConfigDtoToInput } from "@/lib/client-config-v2";
import { buildHostsPath, useAppNavigate } from "@/lib/app-navigation";

interface SwarmHostsPanelProps {
  projectId: string;
  isAuthenticated: boolean;
  canManage: boolean;
}

export function SwarmHostsPanel({
  projectId,
  isAuthenticated,
  canManage,
}: SwarmHostsPanelProps) {
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });
  const [createOpen, setCreateOpen] = useState(false);

  // Show Swarm-owned clients + untagged/legacy ones (untagged is visible to
  // both products). Chatbox/suite-owned clients belong to those surfaces.
  const clients = useMemo(
    () =>
      hosts
        .filter((h) => !h.ownerScope || h.ownerScope.type === "journeys")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [hosts],
  );

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Clients</h2>
          <p className="text-sm text-muted-foreground">
            Standalone clients your journeys run against — configured here, no
            publish surface.
          </p>
        </div>
        {canManage ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-1.5 size-4" />
            New client
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading clients…
        </div>
      ) : clients.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No clients yet.{" "}
          {canManage
            ? "Create one to give your journeys something to run against."
            : "Ask a project admin to add one."}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {clients.map((item) => (
            <SwarmHostRow
              key={item.hostId}
              item={item}
              projectId={projectId}
              isAuthenticated={isAuthenticated}
              canManage={canManage}
            />
          ))}
        </div>
      )}

      {canManage ? (
        <CreateHostDialog
          isOpen={createOpen}
          onClose={() => setCreateOpen(false)}
          projectId={projectId}
          owner="journeys"
          onCreated={(hostId) => {
            setCreateOpen(false);
            toast.success("Client created");
            // Open the editor immediately so the user can pick a model/servers.
            window.location.assign(buildHostsPath(hostId));
          }}
        />
      ) : null}
    </div>
  );
}

function SwarmHostRow({
  item,
  projectId,
  isAuthenticated,
  canManage,
}: {
  item: HostListItem;
  projectId: string;
  isAuthenticated: boolean;
  canManage: boolean;
}) {
  const navigate = useAppNavigate();
  const { updateHost, deleteHost } = useHostMutations();
  // The full config is needed to compose an updateHost input when applying a
  // server group (preserve model/prompt/etc., replace only the server set).
  // Only fetched for admins — non-admins get no Apply affordance.
  const { host } = useHost({
    isAuthenticated: isAuthenticated && canManage,
    hostId: item.hostId,
  });
  const [busy, setBusy] = useState(false);

  const applyGroup = async (_id: string, group: ServerGroup) => {
    if (!host) {
      toast.error("Client config is still loading — try again in a moment.");
      return;
    }
    setBusy(true);
    try {
      // Snapshot semantics: copy the group's servers INTO the host config as
      // the required set (full replace, optional cleared). We store no pointer
      // to the group — later edits to the group do NOT propagate here.
      const input = {
        ...hostConfigDtoToInput(host.config),
        serverIds: group.serverIds,
        optionalServerIds: [],
      };
      await updateHost({ hostId: item.hostId, input });
      toast.success(
        `"${item.name}" now uses "${group.name}" (${group.serverIds.length} server${group.serverIds.length === 1 ? "" : "s"}).`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to apply server group",
      );
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (
      !window.confirm(
        `Delete client "${item.name}"? This can't be undone. (Blocked if any active journey uses it.)`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await deleteHost({ hostId: item.hostId });
      toast.success(`Client "${item.name}" deleted`);
    } catch (err) {
      // The backend rejects deletion while a live journey references the host.
      toast.error(
        err instanceof Error ? err.message : "Failed to delete client",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{item.name}</span>
          {item.ownerScope?.type === "journeys" ? null : (
            <span className="rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              shared
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="truncate">{item.modelId || "no model"}</span>
          <span className="inline-flex items-center gap-1">
            <Server className="size-3" />
            {item.serverCount} server{item.serverCount === 1 ? "" : "s"}
          </span>
          {item.hasComputer ? (
            <span className="inline-flex items-center gap-1">
              <Cpu className="size-3" />
              computer
            </span>
          ) : null}
        </div>
      </div>

      {canManage ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <ServerGroupPicker
            projectId={projectId}
            value={null}
            onChange={(id, group) => void applyGroup(id, group)}
            disabled={busy}
            emptyTriggerLabel="Apply server group"
            infoText="Applies a server group's servers to this client (a snapshot copy — later edits to the group don't propagate)."
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => navigate(buildHostsPath(item.hostId))}
            title="Edit this client in Connect"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void onDelete()}
            title="Delete this client"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// Re-exported icon so the empty-Swarms toggle can share the same glyph.
export { Boxes as SwarmClientsIcon };
