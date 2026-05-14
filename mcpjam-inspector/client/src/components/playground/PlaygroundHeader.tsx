import { useEffect, useState } from "react";
import { useConvexAuth } from "convex/react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { PlaygroundViewTabs } from "./PlaygroundViewTabs";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { HostPicker } from "@/components/hosts/HostPicker";
import { useHostList } from "@/hooks/useHosts";
import { useViewStateContext } from "@/hooks/use-view-state";
import {
  usePlaygroundViews,
  type PlaygroundViewId,
  type ProjectId,
} from "@/hooks/use-playground-views";

interface PlaygroundHeaderProps {
  projectId?: ProjectId;
}

/**
 * Single-strip Playground toolbar.
 *
 * Layout, left to right:
 *   [view tabs … + new]   [host pill] [Save]
 *
 * Saved views render as horizontal IDE-style tabs (see `PlaygroundViewTabs`)
 * so switching is one click. Rename/Set default/Delete live in each tab's
 * hover ⋯; "Save As new view" lives on the trailing "+ New view" tab.
 *
 * Rail toggles live on the rails themselves (the chat-v2 `CollapsedPanelStrip`
 * peek buttons), not in this header — there's no Panels dropdown anymore.
 */
export function PlaygroundHeader({ projectId }: PlaygroundHeaderProps) {
  const { payload, setPayload, isDirty } = useViewStateContext();
  const hostsEnabled = useFeatureFlagEnabled("hosts-enabled");
  const { isAuthenticated } = useConvexAuth();
  const { hosts: hostList, isLoading: hostsLoading } = useHostList({
    isAuthenticated,
    projectId: hostsEnabled && projectId ? projectId : null,
  });

  // Auto-select a host whenever the view doesn't reference one (or references
  // a host that no longer exists). The picker is meant to always show a real
  // host once any are available.
  useEffect(() => {
    if (!hostsEnabled || !projectId) return;
    if (hostsLoading || hostList.length === 0) return;
    const current = payload.servers.hostId;
    if (current && hostList.some((h) => h.hostId === current)) return;
    const first = hostList[0].hostId;
    setPayload((p) => ({
      ...p,
      servers: { ...p.servers, hostId: first },
    }));
  }, [
    hostsEnabled,
    projectId,
    hostsLoading,
    hostList,
    payload.servers.hostId,
    setPayload,
  ]);
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

  const saveDisabled = isSaving || (!isDirty && !!activeViewId);

  return (
    <div className="flex h-full min-w-0 items-center gap-1">
      <PlaygroundViewTabs
        views={views}
        activeViewId={activeViewId}
        isDirty={isDirty}
        isLoading={isLoading}
        onSelect={selectView}
        onSaveAs={() => setSaveAsOpen(true)}
        onRename={(view) => {
          setRenaming(view._id);
          setRenameValue(view.name);
        }}
        onSetDefault={(viewId) => {
          void setDefault(viewId);
        }}
        onDelete={(view) => handleDelete(view._id, view.name)}
      />

      {/* Right: context + actions */}
      {hostsEnabled && projectId ? (
        <div className="hidden min-w-0 sm:block [&_button]:h-7 [&_button]:rounded-md [&_button]:border-transparent [&_button]:bg-transparent [&_button]:px-2 [&_button]:text-xs [&_button]:shadow-none [&_button]:hover:bg-accent">
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
            placeholder="Select a host"
            includeNone={false}
          />
        </div>
      ) : null}

      <Button
        size="sm"
        className="ml-1 h-7 gap-1.5 px-2.5 text-xs"
        onClick={handleSave}
        disabled={saveDisabled}
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

