import { useMemo } from "react";
import { Loader2, X } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import { HostPicker } from "@/components/hosts/HostPicker";
import { useHost, useHostList, type HostListItem } from "@/hooks/useHosts";
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
};

export function HostAttachmentsEditor({
  projectId,
  value,
  onChange,
  disabled = false,
}: HostAttachmentsEditorProps) {
  const { isAuthenticated } = useConvexAuth();
  const { hosts } = useHostList({ isAuthenticated, projectId });

  const attachedIds = useMemo(
    () => new Set(value.map((attachment) => attachment.namedHostId)),
    [value],
  );

  const hostsById = useMemo(() => {
    const map = new Map<string, HostListItem>();
    for (const host of hosts) map.set(host.hostId, host);
    return map;
  }, [hosts]);

  const handleAddHost = (hostId: string | null) => {
    if (!hostId || attachedIds.has(hostId)) return;
    onChange([
      ...value,
      { namedHostId: hostId, enabledOptionalServerIds: [] },
    ]);
  };

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
        <Label className="text-xs text-muted-foreground">Attach a host</Label>
        <HostPicker
          projectId={projectId}
          value={null}
          onChange={handleAddHost}
          placeholder={
            attachedIds.size === hosts.length && hosts.length > 0
              ? "All hosts attached"
              : "Choose a host to attach"
          }
          includeNone={false}
          disabled={
            disabled ||
            (attachedIds.size === hosts.length && hosts.length > 0)
          }
        />
      </div>
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

  const optionalServers = useMemo(() => {
    if (!host) return [];
    return host.config.optionalServerIds.map((serverId) => {
      const server = projectServers.find(
        (candidate) => candidate._id === serverId,
      );
      return {
        id: serverId,
        name: server?.name ?? serverId,
      };
    });
  }, [host, projectServers]);

  const requiredServers = useMemo(() => {
    if (!host) return [];
    return host.config.serverIds.map((serverId) => {
      const server = projectServers.find(
        (candidate) => candidate._id === serverId,
      );
      return server?.name ?? serverId;
    });
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
          {requiredServers.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Always: {requiredServers.join(", ")}
            </p>
          ) : null}
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

      {optionalServers.length > 0 ? (
        <div className="mt-3 space-y-2">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Optional servers
          </Label>
          <div className="space-y-1">
            {optionalServers.map((server) => {
              const isEnabled = enabledSet.has(server.id);
              return (
                <label
                  key={server.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent/30"
                >
                  <Checkbox
                    checked={isEnabled}
                    onCheckedChange={(checked) =>
                      onToggleOptional(server.id, checked === true)
                    }
                    disabled={disabled}
                  />
                  <span className="truncate">{server.name}</span>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
