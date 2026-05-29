import { useMemo, useState } from "react";
import { ChevronRight, Loader2, Plus, X } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { ClientPicker } from "@/components/clients/ClientPicker";
import { CreateClientDialog } from "@/components/clients/CreateClientDialog";
import { AttachmentEditor } from "@/components/clients/attachment-editor";
import { useHost, useHostList, type HostListItem } from "@/hooks/useClients";
import { useProjectServers } from "@/hooks/useViews";
import { cn } from "@/lib/utils";

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

  // PR 0 fix: per-id toggle creates a stale-closure bug when the modal's
  // Save fires a diff-and-emit chain of N toggles in one tick — each
  // toggle reads `value` from this closure, which doesn't see the
  // previous toggle's update until React re-renders the parent. So
  // multi-toggle saves were dropping all but the last change. Full-array
  // setter applies the whole next selection atomically.
  const handleSetSelectedServerIds = (
    index: number,
    enabledOptionalServerIds: string[],
  ) => {
    onChange(
      value.map((attachment, i) =>
        i === index
          ? { ...attachment, enabledOptionalServerIds }
          : attachment,
      ),
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
              onSetSelectedServerIds={(next) =>
                handleSetSelectedServerIds(index, next)
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
              onChange={handleAddHost}
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
        onCreated={handleAddHost}
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
  /**
   * Full-array setter. The AttachmentEditor produces the next full pick
   * on Save; passing the array atomically avoids the stale-closure trap
   * that a per-id toggle chain falls into when N edits batch in one tick.
   */
  onSetSelectedServerIds: (selectedServerIds: string[]) => void;
  disabled: boolean;
};

function HostAttachmentRow({
  attachment,
  hostName,
  projectId,
  isAuthenticated,
  onRemove,
  onSetSelectedServerIds,
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

  // PR B: row body is a click target that opens the AttachmentEditor.
  // The modal owns the editable Servers tab (flat project-pool list).
  const [editorOpen, setEditorOpen] = useState(false);

  const resolveName = (serverId: string) =>
    projectServers.find((s) => s._id === serverId)?.name ?? serverId;

  // Compact summary: "N servers picked" — the attachment owns its full
  // selection, no required/optional split to surface here. Empty
  // selection is callout-worthy (eval cannot run).
  const pickedCount = attachment.enabledOptionalServerIds.length;
  const pickedNames = useMemo(
    () => attachment.enabledOptionalServerIds.map(resolveName),
    // resolveName closes over projectServers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attachment.enabledOptionalServerIds, projectServers],
  );

  return (
    <>
      <div className="rounded-xl border bg-card/60">
        <div className="flex items-start justify-between gap-2 p-3">
          <button
            type="button"
            onClick={() => setEditorOpen(true)}
            disabled={disabled || !host}
            className={cn(
              "group flex min-w-0 flex-1 items-center gap-2 text-left",
              "rounded-md px-1 py-0.5 -mx-1 -my-0.5",
              "hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              (disabled || !host) && "cursor-not-allowed opacity-60",
            )}
            aria-label={`Edit attachment for ${hostName ?? host?.name ?? "host"}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {hostName ?? host?.name ?? "Loading…"}
                </span>
                {isLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                ) : null}
              </div>
              <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                {host ? (
                  pickedCount === 0 ? (
                    <span className="text-amber-600 dark:text-amber-400">
                      No servers picked · click to choose from project pool
                    </span>
                  ) : (
                    <>
                      {pickedCount} server{pickedCount === 1 ? "" : "s"}{" "}
                      picked
                      {pickedNames.length > 0 ? (
                        <span className="ml-1 truncate">
                          · {pickedNames.slice(0, 3).join(", ")}
                          {pickedNames.length > 3
                            ? `, +${pickedNames.length - 3}`
                            : ""}
                        </span>
                      ) : null}
                    </>
                  )
                ) : (
                  "Loading client profile…"
                )}
              </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
          </button>
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
      </div>

      {host ? (
        <AttachmentEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          scope="suite"
          hostId={attachment.namedHostId}
          projectId={projectId}
          isAuthenticated={isAuthenticated}
          selectedServerIds={attachment.enabledOptionalServerIds}
          onSave={({ selectedServerIds }) => {
            // PR B: AttachmentEditor returns the full picked array; the
            // wire field on the parent draft is still named
            // `enabledOptionalServerIds` (see HostAttachmentDraft
            // comment). Pass through to the full-array setter.
            onSetSelectedServerIds(selectedServerIds);
          }}
        />
      ) : null}
    </>
  );
}
