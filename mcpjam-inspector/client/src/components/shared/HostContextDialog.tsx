import { toast } from "sonner";
import { AlertTriangle, RotateCcw, Save } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { JsonEditor } from "@/components/ui/json-editor";
import type { WorkspaceHostContextDraft } from "@/lib/client-config";
import { useWorkspaceClientConfigSyncPending } from "@/hooks/use-workspace-client-config-sync-pending";
import { useHostContextStore } from "@/stores/host-context-store";

interface HostContextDialogProps {
  activeWorkspaceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaveHostContext?: (
    workspaceId: string,
    hostContext: WorkspaceHostContextDraft,
  ) => Promise<void>;
}

export function HostContextDialog({
  activeWorkspaceId,
  open,
  onOpenChange,
  onSaveHostContext,
}: HostContextDialogProps) {
  const draftHostContext = useHostContextStore((state) => state.draftHostContext);
  const hostContextText = useHostContextStore((state) => state.hostContextText);
  const hostContextError = useHostContextStore((state) => state.hostContextError);
  const isDirty = useHostContextStore((state) => state.isDirty);
  const isSaving = useHostContextStore((state) => state.isSaving);
  const setHostContextText = useHostContextStore(
    (state) => state.setHostContextText,
  );
  const resetToBaseline = useHostContextStore((state) => state.resetToBaseline);
  const failSave = useHostContextStore((state) => state.failSave);
  const syncPending = useWorkspaceClientConfigSyncPending(activeWorkspaceId);

  const handleSave = async () => {
    if (!activeWorkspaceId || !onSaveHostContext || hostContextError) {
      return;
    }

    try {
      await onSaveHostContext(activeWorkspaceId, draftHostContext);
      toast.success("Host context saved.");
      onOpenChange(false);
    } catch {
      failSave();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-[min(96vw,60rem)] max-w-[60rem] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Host Context</DialogTitle>
          <DialogDescription>
            Edit the persisted `hostContext` payload used for preview/runtime
            host data.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
          {hostContextError && (
            <div className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {hostContextError}
            </div>
          )}

          <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border border-border/70 bg-background">
            <JsonEditor
              rawContent={hostContextText}
              onRawChange={setHostContextText}
              mode="edit"
              readOnly={isSaving || syncPending}
              showModeToggle={false}
              className="border-0 bg-background"
              height="100%"
              wrapLongLinesInEdit={false}
              showLineNumbers
            />
          </div>
        </div>

        <DialogFooter className="border-t px-5 py-4">
          <Button
            variant="outline"
            onClick={resetToBaseline}
            disabled={!isDirty || isSaving || syncPending}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={
              !activeWorkspaceId ||
              !onSaveHostContext ||
              !isDirty ||
              !!hostContextError ||
              isSaving ||
              syncPending
            }
          >
            <Save className="mr-2 h-4 w-4" />
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
