import { useState, useCallback, useEffect, useMemo } from "react";
import { Check, ChevronDown, Loader2, Plus, Server } from "lucide-react";
import { useMutation, useConvexAuth } from "convex/react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { cn } from "@/lib/utils";
import { useProjectServerAttachments } from "@/hooks/useViews";
import { useProjectServers } from "@/hooks/useViews";
import { ServerSelectionList } from "@/components/clients/server-selection-list";
import type { EvalServerAttachment } from "./types";

type ServerAttachmentPickerProps = {
  projectId: string;
  value: string | null;
  onChange: (serverAttachmentId: string) => void;
  disabled?: boolean;
};

export function ServerAttachmentPicker({
  projectId,
  value,
  onChange,
  disabled = false,
}: ServerAttachmentPickerProps) {
  const { isAuthenticated } = useConvexAuth();
  const { serverAttachments, isLoading } = useProjectServerAttachments({
    isAuthenticated,
    projectId,
  });
  const { servers: projectServers = [] } = useProjectServers({
    isAuthenticated,
    projectId,
  });

  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createServerIds, setCreateServerIds] = useState<Set<string>>(
    new Set()
  );
  const [isCreating, setIsCreating] = useState(false);
  // Optimistic record for the row we just created — the live
  // `serverAttachments` query takes a beat to refetch, and without
  // this fallback the trigger keeps the amber "pick one" styling
  // even though `value` already points at the new id, which makes
  // users think the save failed.
  const [justCreated, setJustCreated] = useState<EvalServerAttachment | null>(
    null,
  );

  const createServerAttachment = useMutation(
    "serverAttachments:createServerAttachment" as any
  );

  // The optimistic record must not outlive the in-flight create window
  // — otherwise switching to another suite (which feeds a new `value`,
  // potentially null) would strand it and show a prior attachment as
  // if it were persisted on the new suite. Clear as soon as the live
  // query reflects the row, with a bounded fallback so a parent reset
  // mid-flight still releases it.
  useEffect(() => {
    if (!justCreated) return;
    if (serverAttachments.some((s) => s._id === justCreated._id)) {
      setJustCreated(null);
      return;
    }
    const t = setTimeout(() => setJustCreated(null), 3000);
    return () => clearTimeout(t);
  }, [justCreated, serverAttachments]);

  const selectedAttachment = useMemo(() => {
    // `value` lags behind onChange when the parent persists through a
    // remote mutation (e.g. suite overview bar → updateSuite). Fall
    // back to justCreated._id so the trigger reflects the new
    // attachment immediately instead of flashing the amber state.
    const effectiveId = value ?? justCreated?._id ?? null;
    if (!effectiveId) return null;
    const fromQuery = serverAttachments.find((s) => s._id === effectiveId);
    if (fromQuery) return fromQuery;
    if (justCreated && justCreated._id === effectiveId) return justCreated;
    return null;
  }, [value, serverAttachments, justCreated]);

  const handleSelect = useCallback(
    (attachment: EvalServerAttachment) => {
      onChange(attachment._id);
      setOpen(false);
    },
    [onChange]
  );

  const handleToggleServer = useCallback(
    (serverId: string, checked: boolean) => {
      setCreateServerIds((prev) => {
        const next = new Set(prev);
        if (checked) next.add(serverId);
        else next.delete(serverId);
        return next;
      });
    },
    []
  );

  const handleCreate = useCallback(async () => {
    const name = createName.trim();
    if (!name) return;
    setIsCreating(true);
    try {
      const pickedServerIds = Array.from(createServerIds);
      const result = (await createServerAttachment({
        projectId,
        name,
        serverIds: pickedServerIds,
      })) as { _id: string };
      setJustCreated({
        _id: result._id,
        name,
        serverIds: pickedServerIds,
        resolvedServerNames: projectServers
          .filter((s) => pickedServerIds.includes(s._id))
          .map((s) => s.name),
      });
      onChange(result._id);
      setOpen(false);
      setShowCreate(false);
      setCreateName("");
      setCreateServerIds(new Set());
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to create server attachment";
      toast.error(msg);
    } finally {
      setIsCreating(false);
    }
  }, [
    createName,
    createServerIds,
    createServerAttachment,
    onChange,
    projectId,
    projectServers,
  ]);

  const triggerLabel = selectedAttachment
    ? selectedAttachment.name
    : "No server attachment · pick one";
  const triggerCount = selectedAttachment
    ? `${selectedAttachment.serverIds.length} server${selectedAttachment.serverIds.length === 1 ? "" : "s"}`
    : null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          // Reopen should always land back on the attachment list, not
          // a half-filled create form from the last session.
          setShowCreate(false);
          setCreateName("");
          setCreateServerIds(new Set());
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border px-2 text-foreground",
            "outline-none transition-colors",
            !selectedAttachment
              ? "border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20"
              : "border-border/60 bg-muted/40 hover:bg-muted/60",
            disabled && "cursor-not-allowed opacity-50"
          )}
        >
          <Server className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {triggerLabel}
          </span>
          {triggerCount ? (
            <span className="text-[10px] text-muted-foreground">
              · {triggerCount}
            </span>
          ) : null}
          {isLoading ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="w-64 p-1"
        align="start"
        sideOffset={4}
        onInteractOutside={() => {
          if (!isCreating) setShowCreate(false);
        }}
      >
        {!showCreate ? (
          <div className="space-y-0.5">
            {serverAttachments.length === 0 && !isLoading ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                No server attachments yet — create one below.
              </p>
            ) : null}
            {serverAttachments.map((attachment) => (
              <button
                key={attachment._id}
                type="button"
                onClick={() =>
                  handleSelect(attachment as EvalServerAttachment)
                }
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                  "hover:bg-accent hover:text-accent-foreground",
                  attachment._id === value && "bg-accent/50"
                )}
              >
                <Check
                  className={cn(
                    "size-3.5 shrink-0",
                    attachment._id === value ? "opacity-100" : "opacity-0"
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{attachment.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {attachment.serverIds.length} server
                    {attachment.serverIds.length === 1 ? "" : "s"}
                  </div>
                </div>
              </button>
            ))}
            <div className="pt-0.5">
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                <span>Create new attachment…</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 p-1">
            <div className="space-y-1">
              <Label htmlFor="server-attachment-name" className="text-[11px]">
                Attachment name
              </Label>
              <Input
                id="server-attachment-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g. Production servers"
                className="h-7 text-xs"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreate();
                  if (e.key === "Escape") {
                    setShowCreate(false);
                    setCreateName("");
                    setCreateServerIds(new Set());
                  }
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">
                Servers ({createServerIds.size} picked)
              </Label>
              <ServerSelectionList
                servers={projectServers.map((s) => ({
                  id: s._id,
                  name: s.name,
                }))}
                selectedIds={createServerIds}
                onToggle={handleToggleServer}
                emptyState={
                  <p className="px-2 py-1 text-xs italic text-muted-foreground">
                    No servers in the project pool yet.
                  </p>
                }
                ariaLabel="Pick servers for this attachment"
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                className="h-7 flex-1 text-xs"
                disabled={!createName.trim() || isCreating}
                onClick={() => void handleCreate()}
              >
                {isCreating ? (
                  <Loader2 className="mr-1 size-3 animate-spin" />
                ) : null}
                Create
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  setShowCreate(false);
                  setCreateName("");
                  setCreateServerIds(new Set());
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
