import { useState, useCallback, useEffect, useMemo } from "react";
import {
  Check,
  ChevronDown,
  Info,
  Loader2,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { useProjectServerAttachments } from "@/hooks/useViews";
import { useProjectServers } from "@/hooks/useViews";
import { ServerSelectionList } from "@/components/hosts/server-selection-list";
import type { EvalServerAttachment } from "./types";

type ServerAttachmentPickerProps = {
  projectId: string;
  value: string | null;
  /**
   * The full attachment record is passed alongside the id so callers
   * that persist by server set (e.g. chatboxes) don't have to re-read
   * the live query — which lags behind for just-created rows.
   */
  onChange: (
    serverAttachmentId: string,
    attachment: EvalServerAttachment,
  ) => void;
  disabled?: boolean;
  /** Trigger label when no attachment is selected. */
  emptyTriggerLabel?: string;
  /** Info-tooltip copy explaining what an attachment is in this context. */
  infoText?: string;
  /** Tooltip on the delete button when the attachment is the selected one. */
  selectedDeleteHint?: string;
};

export function ServerAttachmentPicker({
  projectId,
  value,
  onChange,
  disabled = false,
  emptyTriggerLabel = "No server attachment · pick one",
  infoText = "A server attachment is a named set of MCP servers that every client in the suite runs against. Reuse the same attachment across suites, or create one per scenario.",
  selectedDeleteHint = "In use by this suite — pick another first",
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
  const [nameTouched, setNameTouched] = useState(false);
  const [createServerIds, setCreateServerIds] = useState<Set<string>>(
    new Set()
  );
  const [isCreating, setIsCreating] = useState(false);
  // Optimistic record for the row we just created — the live
  // `serverAttachments` query takes a beat to refetch, so without
  // this fallback the trigger would briefly show the "pick one"
  // label even though `value` already points at the new id.
  const [justCreated, setJustCreated] = useState<EvalServerAttachment | null>(
    null,
  );

  const createServerAttachment = useMutation(
    "serverAttachments:createServerAttachment" as any
  );
  const deleteServerAttachment = useMutation(
    "serverAttachments:deleteServerAttachment" as any
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);

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
      onChange(attachment._id, attachment);
      setOpen(false);
    },
    [onChange]
  );

  const handleDelete = useCallback(
    async (attachment: EvalServerAttachment) => {
      // Backend rejects if any suite still references this row; surface
      // the server message verbatim so the user sees which suite blocks it.
      setDeletingId(attachment._id);
      try {
        await deleteServerAttachment({ serverAttachmentId: attachment._id });
        toast.success(`Deleted "${attachment.name}"`);
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : "Failed to delete server attachment";
        toast.error(msg);
      } finally {
        setDeletingId(null);
      }
    },
    [deleteServerAttachment],
  );

  const handleToggleServer = useCallback(
    (serverId: string, checked: boolean) => {
      setCreateServerIds((prev) => {
        const next = new Set(prev);
        if (checked) next.add(serverId);
        else next.delete(serverId);
        // Auto-derive name from the first picked server unless the user
        // has explicitly typed one. Sets preserve insertion order, so
        // iterating gives us the earliest still-picked server.
        if (!nameTouched) {
          const firstId = next.values().next().value as string | undefined;
          const firstName = firstId
            ? projectServers.find((s) => s._id === firstId)?.name ?? ""
            : "";
          setCreateName(firstName);
        }
        return next;
      });
    },
    [nameTouched, projectServers]
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
      const created: EvalServerAttachment = {
        _id: result._id,
        name,
        serverIds: pickedServerIds,
        resolvedServerNames: projectServers
          .filter((s) => pickedServerIds.includes(s._id))
          .map((s) => s.name),
      };
      setJustCreated(created);
      onChange(result._id, created);
      setOpen(false);
      setShowCreate(false);
      setCreateName("");
      setNameTouched(false);
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
    : emptyTriggerLabel;
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
          setNameTouched(false);
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
            !value && !justCreated
              ? "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45"
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
        onInteractOutside={(e) => {
          // While a create is in flight, don't let an outside click
          // dismiss the popover mid-request.
          if (isCreating) {
            e.preventDefault();
            return;
          }
          // The Create button sits below the fold when the server list
          // is long, so clicking outside the popover commits the
          // in-progress attachment instead of discarding it. Keep the
          // popover open until handleCreate resolves (it closes itself
          // on success) — closing now would flash the empty trigger
          // during the mutation.
          if (showCreate && createName.trim() && createServerIds.size > 0) {
            e.preventDefault();
            void handleCreate();
          }
        }}
      >
        {!showCreate ? (
          <div className="space-y-0.5">
            <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Server attachments
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="What is a server attachment?"
                    className="rounded-full p-0.5 text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Info className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[240px]">
                  <p className="text-xs leading-snug">{infoText}</p>
                </TooltipContent>
              </Tooltip>
            </div>
            {serverAttachments.length === 0 && !isLoading ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                No server attachments yet — create one below.
              </p>
            ) : null}
            {serverAttachments.map((attachment) => {
              const isSelected = attachment._id === value;
              const isDeleting = deletingId === attachment._id;
              return (
                <div
                  key={attachment._id}
                  className={cn(
                    "group flex w-full items-center gap-1 rounded pr-1 text-sm",
                    "hover:bg-accent hover:text-accent-foreground",
                    isSelected && "bg-accent/50",
                  )}
                >
                  <button
                    type="button"
                    onClick={() =>
                      handleSelect(attachment as EvalServerAttachment)
                    }
                    className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left"
                  >
                    <Check
                      className={cn(
                        "size-3.5 shrink-0",
                        isSelected ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {attachment.name}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {attachment.serverIds.length} server
                        {attachment.serverIds.length === 1 ? "" : "s"}
                      </div>
                    </div>
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {/* span wrapper keeps the tooltip alive when the button is disabled */}
                      <span
                        className="shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isSelected) return;
                            void handleDelete(
                              attachment as EvalServerAttachment,
                            );
                          }}
                          disabled={isDeleting || isSelected}
                          aria-label={`Delete ${attachment.name}`}
                          className="rounded p-1 text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                        >
                          {isDeleting ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                        </button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <p className="text-xs">
                        {isSelected ? selectedDeleteHint : "Delete attachment"}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
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
                onChange={(e) => {
                  setNameTouched(true);
                  setCreateName(e.target.value);
                }}
                placeholder="Auto-filled from first server"
                className="h-7 text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreate();
                  if (e.key === "Escape") {
                    setShowCreate(false);
                    setCreateName("");
                    setNameTouched(false);
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
                disabled={
                  createServerIds.size === 0 ||
                  !createName.trim() ||
                  isCreating
                }
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
                  setNameTouched(false);
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
