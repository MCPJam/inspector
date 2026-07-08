import { useState, useCallback, useEffect, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import { useMutation, useConvexAuth } from "convex/react";
import { toast } from "@/lib/toast";
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
  /**
   * When provided, the currently-selected group can be deleted from the
   * list and this is called to clear the now-dangling selection. Omit it
   * where the selection is persisted to a saved suite — there the in-use
   * group stays locked (the backend rejects it anyway). Passing it signals
   * an unsaved selection (e.g. the create-suite dialog) that's safe to drop.
   */
  onClearSelection?: () => void;
  /**
   * Render the dropdown in place instead of portaling it to <body>. Set
   * this when the picker lives inside a modal Dialog, whose scroll-lock
   * otherwise blocks wheel-scrolling the server list. Leave false on bars
   * and other non-modal surfaces so the dropdown can overflow freely.
   */
  inModal?: boolean;
};

export function ServerAttachmentPicker({
  projectId,
  value,
  onChange,
  disabled = false,
  emptyTriggerLabel = "No server group · pick one",
  infoText = "A server group is a named set of MCP servers that every host in the suite runs against.",
  selectedDeleteHint = "In use by this suite — pick another first",
  onClearSelection,
  inModal = false,
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
  // Which group row is expanded to reveal its server names.
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
      // Clicking a row both picks the group and reveals its servers —
      // keep the popover open and expand this row (collapse on re-click).
      setExpandedId((cur) => (cur === attachment._id ? null : attachment._id));
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
        // Deleting the group we had picked leaves the selection dangling —
        // clear it so the suite falls back to "No server group · pick one".
        if (attachment._id === value) onClearSelection?.();
        toast.success(`Deleted "${attachment.name}"`);
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : "Failed to delete server group";
        toast.error(msg);
      } finally {
        setDeletingId(null);
      }
    },
    [deleteServerAttachment, value, onClearSelection],
  );

  // Auto-name new groups "group 1", "group 2", … using the lowest number
  // not already taken — the name no longer depends on the picked servers.
  const nextGroupName = useCallback(() => {
    const used = new Set<number>();
    for (const a of serverAttachments) {
      const m = /^group (\d+)$/i.exec((a.name ?? "").trim());
      if (m) used.add(Number(m[1]));
    }
    let n = 1;
    while (used.has(n)) n++;
    return `group ${n}`;
  }, [serverAttachments]);

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
    if (!name || createServerIds.size === 0) return;
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
      setCreateServerIds(new Set());
    } catch (err) {
      const raw = err instanceof Error ? err.message : "";
      // The backend rejects duplicate names with a verbose, stack-y message;
      // surface a clean toast instead of leaking it.
      const msg = /already exists/i.test(raw)
        ? `A server group named "${name}" already exists.`
        : "Failed to create server group";
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
        // Inside a modal, render in place (not portaled to <body>) so the
        // list scrolls — the dialog's scroll-lock blocks the wheel on
        // portaled content rendered outside it.
        portalled={!inModal}
        onInteractOutside={(e) => {
          // While a create is in flight, don't let an outside click
          // dismiss the popover mid-request.
          if (isCreating) {
            e.preventDefault();
            return;
          }
          // Clicking outside the popover commits the in-progress
          // attachment instead of discarding it — the Create button can
          // sit below the fold when the server list is long, so the
          // click-away IS the save. Keep the popover open until
          // handleCreate resolves (it closes itself on success) so the
          // trigger doesn't flash empty during the mutation.
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
                Server groups
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="What is a server group?"
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
                No server groups yet — create one below.
              </p>
            ) : null}
            {serverAttachments.map((attachment) => {
              const isSelected = attachment._id === value;
              const isDeleting = deletingId === attachment._id;
              // The selected group is only locked from deletion when the
              // selection is persisted (no onClearSelection handler) — e.g.
              // a saved suite. In the unsaved create dialog it's deletable.
              const lockSelected = isSelected && !onClearSelection;
              const isExpanded = expandedId === attachment._id;
              const serverNames = attachment.resolvedServerNames ?? [];
              return (
                <div key={attachment._id}>
                <div
                  className={cn(
                    "group flex w-full items-center gap-1 rounded pr-1 text-sm",
                    "hover:bg-accent hover:text-accent-foreground",
                    isSelected && "bg-accent/50",
                  )}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedId(isExpanded ? null : attachment._id)
                    }
                    aria-expanded={isExpanded}
                    aria-label={
                      isExpanded
                        ? `Hide servers in ${attachment.name}`
                        : `Show servers in ${attachment.name}`
                    }
                    className="shrink-0 rounded p-1 text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronRight
                      className={cn(
                        "size-3.5 transition-transform",
                        isExpanded && "rotate-90",
                      )}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleSelect(attachment as EvalServerAttachment)
                    }
                    className="flex min-w-0 flex-1 items-center rounded px-2 py-1.5 text-left"
                  >
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
                            if (lockSelected) return;
                            void handleDelete(
                              attachment as EvalServerAttachment,
                            );
                          }}
                          disabled={isDeleting || lockSelected}
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
                        {lockSelected ? selectedDeleteHint : "Delete group"}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                {isExpanded ? (
                  <div className="pb-1 pl-7 pr-2 pt-0.5">
                    {serverNames.length === 0 ? (
                      <p className="py-0.5 text-[11px] italic text-muted-foreground">
                        No servers in this group.
                      </p>
                    ) : (
                      <ul className="space-y-0.5">
                        {serverNames.map((name, i) => (
                          <li
                            key={`${attachment._id}-${i}`}
                            className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground"
                          >
                            <Server className="size-3 shrink-0" />
                            <span className="truncate">{name}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
                </div>
              );
            })}
            <div className="pt-0.5">
              <button
                type="button"
                onClick={() => {
                  setShowCreate(true);
                  setCreateName(nextGroupName());
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                <span>Create new group…</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 p-1">
            <div className="space-y-1">
              <Label htmlFor="server-attachment-name" className="text-[11px]">
                Group name
              </Label>
              <Input
                id="server-attachment-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g. group 3"
                className="h-7 text-xs"
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
              {/* Scroll the list internally so a long server pool never
                  pushes the Create button below the fold. */}
              <div className="max-h-48 overflow-y-auto pr-1">
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
                  ariaLabel="Pick servers for this group"
                />
              </div>
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
