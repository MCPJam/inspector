import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { ClientPicker } from "@/components/clients/ClientPicker";
import { CreateClientDialog } from "@/components/clients/CreateClientDialog";
import { resolveHostLogoByDisplayName } from "@/lib/chatbox-client-style";
import { useHostList, type HostListItem } from "@/hooks/useClients";

export type HostAttachmentDraft = {
  namedHostId: string;
  /**
   * The attachment's full server pick from the project pool. PR B
   * model: no required/optional split, no inheritance from the bound
   * host's hostConfig. Empty array = "user hasn't picked yet" (eval
   * runs reject empty at run-start).
   *
   * The field name on the wire is still `enabledOptionalServerIds`
   * because the suite-update mutation pre-dates this rename; PR B
   * accepts both `enabledOptionalServerIds` and `selectedServerIds`
   * and prefers the latter. The frontend draft type follows the
   * legacy name to minimize churn in parent components that read
   * `EvalSuite.hostAttachments`; rename in cleanup PR.
   */
  enabledOptionalServerIds: string[];
};

type HostAttachmentsEditorProps = {
  projectId: string;
  value: HostAttachmentDraft[];
  onChange: (next: HostAttachmentDraft[]) => void;
  disabled?: boolean;
};

export function ClientAttachmentsEditor({
  projectId,
  value,
  onChange,
  disabled = false,
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

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {value.length === 0 ? (
          <div className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
            No hosts attached. Attach one or more hosts to fan runs out across
            them.
          </div>
        ) : (
          value.map((attachment, index) => (
            <HostAttachmentRow
              key={attachment.namedHostId}
              attachment={attachment}
              hostName={hostsById.get(attachment.namedHostId)?.name}
              onRemove={() => handleRemoveAttachment(index)}
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
              onChange={handleAddHost}
              location="eval_runner"
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
        onCreated={handleAddHost}
      />
    </div>
  );
}

type HostAttachmentRowProps = {
  attachment: HostAttachmentDraft;
  hostName: string | undefined;
  onRemove: () => void;
  disabled: boolean;
};

function HostAttachmentRow({
  attachment,
  hostName,
  onRemove,
  disabled,
}: HostAttachmentRowProps) {
  const displayName = hostName ?? attachment.namedHostId;
  const logoSrc = resolveHostLogoByDisplayName(displayName);

  return (
    <div className="rounded-xl border bg-card/60">
      <div className="flex items-center justify-between gap-2 p-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {logoSrc ? (
            <img
              src={logoSrc}
              alt=""
              className="size-3.5 shrink-0 object-contain"
            />
          ) : (
            <span
              aria-hidden
              className="size-3.5 shrink-0 rounded-full bg-muted"
            />
          )}
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${displayName}`}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
