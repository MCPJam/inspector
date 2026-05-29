import { useMemo, useState } from "react";
import { Loader2, Lock, Plus, X } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import { ClientPicker } from "@/components/clients/ClientPicker";
import { CreateClientDialog } from "@/components/clients/CreateClientDialog";
import { useHost, useHostList, type HostListItem } from "@/hooks/useClients";
import { useProjectServers } from "@/hooks/useViews";

export type HostAttachmentDraft = {
  namedHostId: string;
  enabledOptionalServerIds: string[];
};

type HostAttachmentsEditorProps = {
  projectId: string;
  value: HostAttachmentDraft[];
  onChange: (next: HostAttachmentDraft[]) => void;
  disabled?: boolean;
  /**
   * Server IDs in scope for the surrounding context (e.g. the suite being
   * created/edited). When non-empty and the user clicks `+ Create new`,
   * the new-client dialog surfaces an opt-in checkbox to pre-attach these
   * servers as optionals on the new client.
   */
  suiteServers?: string[];
};

export function ClientAttachmentsEditor({
  projectId,
  value,
  onChange,
  disabled = false,
  suiteServers,
}: HostAttachmentsEditorProps) {
  const { isAuthenticated } = useConvexAuth();
  const { hosts } = useHostList({ isAuthenticated, projectId });
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const attachedIds = useMemo(
    () => new Set(value.map((attachment) => attachment.namedHostId)),
    [value],
  );

  const hostsById = useMemo(() => {
    const map = new Map<string, HostListItem>();
    for (const host of hosts) map.set(host.hostId, host);
    return map;
  }, [hosts]);

  /**
   * Attach a host. `prefilledOptionalServerIds` lets the caller pre-enable
   * specific optional servers (used right after inline client creation so
   * the freshly-prefilled servers appear checked from the first render
   * without forcing the user to re-toggle them).
   */
  const handleAddHost = (
    hostId: string | null,
    prefilledOptionalServerIds: string[] = [],
  ) => {
    if (!hostId || attachedIds.has(hostId)) return;
    onChange([
      ...value,
      {
        namedHostId: hostId,
        enabledOptionalServerIds: [...prefilledOptionalServerIds],
      },
    ]);
  };

  const prefillServerIds = suiteServers ?? [];
  const canPrefill = prefillServerIds.length > 0;

  const handleRemoveAttachment = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const handleToggleOptional = (
    index: number,
    serverId: string,
    enabled: boolean,
  ) => {
    onChange(
      value.map((attachment, i) => {
        if (i !== index) return attachment;
        const current = new Set(attachment.enabledOptionalServerIds);
        if (enabled) current.add(serverId);
        else current.delete(serverId);
        return {
          ...attachment,
          enabledOptionalServerIds: Array.from(current),
        };
      }),
    );
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {value.length === 0 ? (
          <div className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
            No hosts attached. Without a host, the suite runs against its
            flat server list. Attach one or more hosts to fan runs out across
            them.
          </div>
        ) : (
          value.map((attachment, index) => (
            <HostAttachmentRow
              key={attachment.namedHostId}
              attachment={attachment}
              hostName={hostsById.get(attachment.namedHostId)?.name}
              projectId={projectId}
              isAuthenticated={isAuthenticated}
              onRemove={() => handleRemoveAttachment(index)}
              onToggleOptional={(serverId, enabled) =>
                handleToggleOptional(index, serverId, enabled)
              }
              disabled={disabled}
            />
          ))
        )}
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Attach a client</Label>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <ClientPicker
              projectId={projectId}
              value={null}
              onChange={(hostId) => handleAddHost(hostId)}
              location="eval_runner"
              placeholder={
                attachedIds.size === hosts.length && hosts.length > 0
                  ? "All clients attached"
                  : "Choose a client to attach"
              }
              includeNone={false}
              disabled={
                disabled ||
                (attachedIds.size === hosts.length && hosts.length > 0)
              }
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCreateDialogOpen(true)}
            disabled={disabled}
            className="shrink-0"
          >
            <Plus className="mr-1 h-4 w-4" />
            Create new
          </Button>
        </div>
      </div>

      <CreateClientDialog
        isOpen={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        projectId={projectId}
        onCreated={(hostId, opts) => {
          handleAddHost(
            hostId,
            opts?.prefilledOptionalServerIds ?? [],
          );
        }}
        prefillServersOption={
          canPrefill
            ? {
                label: `Pre-attach the suite's servers (${prefillServerIds.length})`,
                defaultChecked: false,
                serverIds: prefillServerIds,
              }
            : undefined
        }
      />
    </div>
  );
}

type HostAttachmentRowProps = {
  attachment: HostAttachmentDraft;
  hostName: string | undefined;
  projectId: string;
  isAuthenticated: boolean;
  onRemove: () => void;
  onToggleOptional: (serverId: string, enabled: boolean) => void;
  disabled: boolean;
};

function HostAttachmentRow({
  attachment,
  hostName,
  projectId,
  isAuthenticated,
  onRemove,
  onToggleOptional,
  disabled,
}: HostAttachmentRowProps) {
  const { host, isLoading } = useHost({
    isAuthenticated,
    hostId: attachment.namedHostId,
  });
  const { servers: projectServers = [] } = useProjectServers({
    isAuthenticated,
    projectId,
  });

  const enabledSet = useMemo(
    () => new Set(attachment.enabledOptionalServerIds),
    [attachment.enabledOptionalServerIds],
  );

  type ServerRow = {
    id: string;
    name: string;
    required: boolean;
  };

  const serverRows: ServerRow[] = useMemo(() => {
    if (!host) return [];
    const resolveName = (serverId: string) =>
      projectServers.find((candidate) => candidate._id === serverId)?.name ??
      serverId;
    const required = host.config.serverIds.map((id) => ({
      id,
      name: resolveName(id),
      required: true,
    }));
    const optional = host.config.optionalServerIds.map((id) => ({
      id,
      name: resolveName(id),
      required: false,
    }));
    return [...required, ...optional];
  }, [host, projectServers]);

  return (
    <div className="rounded-xl border bg-card/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {hostName ?? host?.name ?? "Loading…"}
            </span>
            {isLoading ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : null}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${hostName ?? "host"}`}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-3 space-y-2">
        <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Servers
        </Label>
        {host && serverRows.length === 0 ? (
          <p className="px-2 py-1 text-xs italic text-muted-foreground">
            No servers attached to this client.
          </p>
        ) : (
          <div className="space-y-1">
            {serverRows.map((server) =>
              server.required ? (
                <div
                  key={server.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground"
                  title="This server is required by the client. Edit on the Client tab to change."
                >
                  <Checkbox checked disabled aria-label={`${server.name} (required)`} />
                  <Lock className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden />
                  <span className="truncate">{server.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                    Required by client
                  </span>
                </div>
              ) : (
                <label
                  key={server.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent/30"
                >
                  <Checkbox
                    checked={enabledSet.has(server.id)}
                    onCheckedChange={(checked) =>
                      onToggleOptional(server.id, checked === true)
                    }
                    disabled={disabled}
                  />
                  <span className="truncate">{server.name}</span>
                </label>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
