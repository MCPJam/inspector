import { useState } from "react";
import {
  ChevronDown,
  Columns2,
  Loader2,
  MoreVertical,
  Save,
  Star,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { listPanes } from "./panes/registry";
import type { PaneId } from "./panes/types";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Switch } from "@mcpjam/design-system/switch";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { HostPicker } from "@/components/hosts/HostPicker";
import { useViewStateContext } from "@/hooks/use-view-state";
import {
  usePlaygroundViews,
  type PlaygroundViewId,
  type ProjectId,
} from "@/hooks/use-playground-views";
import { cn } from "@/lib/utils";

interface PlaygroundHeaderProps {
  projectId?: ProjectId;
}

/**
 * Playground top bar: view picker on the left, dirty-dot + Save / Save As on
 * the right. Phase 6 will tuck the `HostPicker` in between view picker and
 * save buttons.
 */
export function PlaygroundHeader({ projectId }: PlaygroundHeaderProps) {
  const { payload, setPayload, isDirty } = useViewStateContext();
  const hostsEnabled = useFeatureFlagEnabled("hosts-enabled");
  const {
    views,
    isLoading,
    activeViewId,
    selectView,
    saveActive,
    saveAs,
    rename,
    remove,
    setDefault,
  } = usePlaygroundViews(projectId);

  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [renaming, setRenaming] = useState<PlaygroundViewId | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const activeView = views.find((v) => v._id === activeViewId) ?? null;
  const activeLabel = activeView ? activeView.name : "Untitled (scratch)";

  const handleSave = async () => {
    if (!activeViewId) {
      setSaveAsOpen(true);
      return;
    }
    setIsSaving(true);
    try {
      await saveActive();
      toast.success("View saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAs = async (name: string) => {
    if (!name.trim()) return;
    setIsSaving(true);
    try {
      await saveAs(name.trim());
      toast.success(`Saved "${name.trim()}"`);
      setSaveAsOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (viewId: PlaygroundViewId, name: string) => {
    if (!window.confirm(`Delete view "${name}"?`)) return;
    try {
      await remove(viewId);
      toast.success(`Deleted "${name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const handleRename = async (viewId: PlaygroundViewId) => {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    try {
      await rename(viewId, trimmed);
      toast.success("Renamed");
      setRenaming(null);
      setRenameValue("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename");
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs font-medium"
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                isDirty ? "bg-amber-500" : "bg-transparent",
              )}
              aria-label={isDirty ? "Unsaved changes" : undefined}
            />
            <span className="max-w-[200px] truncate">{activeLabel}</span>
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Playground views
          </DropdownMenuLabel>
          {isLoading ? (
            <DropdownMenuItem disabled>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Loading…
            </DropdownMenuItem>
          ) : null}
          {!isLoading && views.length === 0 ? (
            <DropdownMenuItem disabled>No saved views yet</DropdownMenuItem>
          ) : null}
          {views.map((view) => (
            <DropdownMenuItem
              key={view._id}
              onSelect={() => selectView(view._id)}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate">{view.name}</span>
              {view.isDefault ? (
                <Star className="h-3 w-3 fill-current text-amber-500" />
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => selectView(null)}>
            New scratch workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex-1" />

      <PanelsMenu
        leftPanes={payload.layout.leftPanes}
        rightPanes={payload.layout.rightPanes}
        onToggle={(paneId, defaultSide) => {
          setPayload((current) => {
            const inLeft = current.layout.leftPanes.includes(paneId);
            const inRight = current.layout.rightPanes.includes(paneId);
            if (inLeft || inRight) {
              return {
                ...current,
                layout: {
                  ...current.layout,
                  leftPanes: current.layout.leftPanes.filter(
                    (id) => id !== paneId,
                  ),
                  rightPanes: current.layout.rightPanes.filter(
                    (id) => id !== paneId,
                  ),
                },
              };
            }
            const sideKey =
              defaultSide === "right" ? "rightPanes" : "leftPanes";
            return {
              ...current,
              layout: {
                ...current.layout,
                [sideKey]: [...current.layout[sideKey], paneId],
              },
            };
          });
        }}
      />

      <Label className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
        <Switch
          checked={payload.chat.enableMultiModelChat}
          onCheckedChange={(checked) =>
            setPayload((current) => ({
              ...current,
              chat: { ...current.chat, enableMultiModelChat: checked },
            }))
          }
          className="scale-75"
          aria-label="Toggle multi-model chat"
        />
        Multi-model
      </Label>

      {hostsEnabled && projectId ? (
        <div className="w-48">
          <HostPicker
            projectId={projectId}
            value={payload.servers.hostId ?? null}
            onChange={(hostId) =>
              setPayload((current) => ({
                ...current,
                servers: {
                  ...current.servers,
                  hostId: hostId ?? undefined,
                },
              }))
            }
            placeholder="Project default"
            noneLabel="Project default"
          />
        </div>
      ) : null}

      {activeView ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              onSelect={() => {
                setRenaming(activeView._id);
                setRenameValue(activeView.name);
              }}
            >
              Rename…
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void setDefault(activeView._id);
              }}
              disabled={activeView.isDefault}
            >
              {activeView.isDefault ? "Default view" : "Set as default"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => handleDelete(activeView._id, activeView.name)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={() => setSaveAsOpen(true)}
      >
        Save As
      </Button>
      <Button
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={handleSave}
        disabled={isSaving || (!isDirty && !!activeViewId)}
      >
        {isSaving ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Save className="h-3 w-3" />
        )}
        Save
      </Button>

      <SaveAsDialog
        open={saveAsOpen}
        onClose={() => setSaveAsOpen(false)}
        onSave={handleSaveAs}
        isSaving={isSaving}
      />

      <RenameDialog
        open={renaming !== null}
        value={renameValue}
        onChange={setRenameValue}
        onClose={() => {
          setRenaming(null);
          setRenameValue("");
        }}
        onSave={() => {
          if (renaming) void handleRename(renaming);
        }}
      />
    </div>
  );
}

function SaveAsDialog({
  open,
  onClose,
  onSave,
  isSaving,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
  isSaving: boolean;
}) {
  const [name, setName] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          setName("");
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save view as</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="playground-view-name">Name</Label>
          <Input
            id="playground-view-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My workspace"
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) onSave(name);
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={() => onSave(name)} disabled={isSaving || !name.trim()}>
            {isSaving ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  open,
  value,
  onChange,
  onClose,
  onSave,
}: {
  open: boolean;
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename view</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="playground-view-rename">Name</Label>
          <Input
            id="playground-view-rename"
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && value.trim()) onSave();
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={!value.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Panel-toggle dropdown — modeled after the per-pane menu pattern in
 * Claude/Cursor/Linear. Lists every registered pane with a checkbox; toggling
 * adds the pane to its `defaultSide` or removes it from whichever side it's on.
 * Gives users a way back to panes they closed via the SortablePane X button.
 */
function PanelsMenu({
  leftPanes,
  rightPanes,
  onToggle,
}: {
  leftPanes: PaneId[];
  rightPanes: PaneId[];
  onToggle: (paneId: PaneId, defaultSide: "left" | "right") => void;
}) {
  const panes = listPanes();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          aria-label="Panels"
          title="Panels"
        >
          <Columns2 className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Panels
        </DropdownMenuLabel>
        {panes.map((pane) => {
          const PaneIcon = pane.icon;
          const active =
            leftPanes.includes(pane.id) || rightPanes.includes(pane.id);
          return (
            <DropdownMenuCheckboxItem
              key={pane.id}
              checked={active}
              onCheckedChange={() => onToggle(pane.id, pane.defaultSide)}
              className="gap-2"
            >
              <PaneIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{pane.title}</span>
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
