import { useState, useCallback, useMemo } from "react";
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
import { useProjectServerSets } from "@/hooks/useViews";
import { useProjectServers } from "@/hooks/useViews";
import { ServerSelectionList } from "@/components/clients/server-selection-list";
import type { EvalServerSet } from "./types";

type ServerSetPickerProps = {
  projectId: string;
  value: string | null;
  onChange: (serverSetId: string) => void;
  disabled?: boolean;
};

export function ServerSetPicker({
  projectId,
  value,
  onChange,
  disabled = false,
}: ServerSetPickerProps) {
  const { isAuthenticated } = useConvexAuth();
  const { serverSets, isLoading } = useProjectServerSets({
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

  const createServerSet = useMutation("serverSets:createServerSet" as any);

  const selectedSet = useMemo(
    () => (value ? serverSets.find((s) => s._id === value) : null),
    [value, serverSets]
  );

  const handleSelect = useCallback(
    (set: EvalServerSet) => {
      onChange(set._id);
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
      const result = (await createServerSet({
        projectId,
        name,
        serverIds: Array.from(createServerIds),
      })) as { _id: string };
      onChange(result._id);
      setOpen(false);
      setShowCreate(false);
      setCreateName("");
      setCreateServerIds(new Set());
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create server set";
      toast.error(msg);
    } finally {
      setIsCreating(false);
    }
  }, [createName, createServerIds, createServerSet, onChange, projectId]);

  const triggerLabel = selectedSet
    ? selectedSet.name
    : "No server set · pick one";
  const triggerCount =
    selectedSet
      ? `${selectedSet.serverIds.length} server${selectedSet.serverIds.length === 1 ? "" : "s"}`
      : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border px-2 text-foreground",
            "outline-none transition-colors",
            !selectedSet
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
            {serverSets.length === 0 && !isLoading ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                No server sets yet — create one below.
              </p>
            ) : null}
            {serverSets.map((set) => (
              <button
                key={set._id}
                type="button"
                onClick={() => handleSelect(set as EvalServerSet)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                  "hover:bg-accent hover:text-accent-foreground",
                  set._id === value && "bg-accent/50"
                )}
              >
                <Check
                  className={cn(
                    "size-3.5 shrink-0",
                    set._id === value ? "opacity-100" : "opacity-0"
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{set.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {set.serverIds.length} server
                    {set.serverIds.length === 1 ? "" : "s"}
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
                <span>Create new set…</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 p-1">
            <div className="space-y-1">
              <Label className="text-[11px]">Set name</Label>
              <Input
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
                ariaLabel="Pick servers for this set"
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
