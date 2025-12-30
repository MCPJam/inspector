import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Copy,
  Download,
  Edit2,
  Plus,
  Star,
  StarOff,
  Trash2,
  Upload,
} from "lucide-react";
import { Workspace } from "@/state/app-types";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface WorkspaceManagementDialogProps {
  isOpen: boolean;
  onClose: () => void;
  workspaces: Record<string, Workspace>;
  activeWorkspaceId: string;
  onCreateWorkspace: (name: string, description?: string) => void;
  onUpdateWorkspace: (workspaceId: string, updates: Partial<Workspace>) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onDuplicateWorkspace: (workspaceId: string, newName: string) => void;
  onSetDefaultWorkspace: (workspaceId: string) => void;
  onExportWorkspace: (workspaceId: string) => void;
  onImportWorkspace: (workspaceData: Workspace) => void;
}

export function WorkspaceManagementDialog({
  isOpen,
  onClose,
  workspaces,
  activeWorkspaceId,
  onCreateWorkspace,
  onUpdateWorkspace,
  onDeleteWorkspace,
  onDuplicateWorkspace,
  onSetDefaultWorkspace,
  onExportWorkspace,
  onImportWorkspace,
}: WorkspaceManagementDialogProps) {
  const [view, setView] = useState<"list" | "create" | "edit">("list");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspaceDescription, setNewWorkspaceDescription] = useState("");
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | null>(
    null,
  );
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const workspaceList = Object.values(workspaces).sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });

  const handleCreateWorkspace = () => {
    if (newWorkspaceName.trim()) {
      onCreateWorkspace(
        newWorkspaceName.trim(),
        newWorkspaceDescription.trim() || undefined,
      );
      setNewWorkspaceName("");
      setNewWorkspaceDescription("");
      setView("list");
    }
  };

  const handleUpdateWorkspace = () => {
    if (editingWorkspace && editingWorkspace.name.trim()) {
      onUpdateWorkspace(editingWorkspace.id, {
        name: editingWorkspace.name.trim(),
        description: editingWorkspace.description?.trim() || undefined,
      });
      setEditingWorkspace(null);
      setView("list");
    }
  };

  const handleStartEdit = (workspace: Workspace) => {
    setEditingWorkspace({ ...workspace });
    setView("edit");
  };

  const handleDeleteClick = (workspaceId: string) => {
    setDeleteConfirmId(workspaceId);
  };

  const handleConfirmDelete = () => {
    if (deleteConfirmId) {
      onDeleteWorkspace(deleteConfirmId);
      setDeleteConfirmId(null);
    }
  };

  const handleDuplicate = (workspace: Workspace) => {
    const newName = `${workspace.name} (Copy)`;
    onDuplicateWorkspace(workspace.id, newName);
  };

  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        try {
          const text = await file.text();
          const workspaceData = JSON.parse(text);
          onImportWorkspace(workspaceData);
        } catch (error) {
          console.error("Failed to import workspace:", error);
          alert("Failed to import workspace. Please check the file format.");
        }
      }
    };
    input.click();
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Manage Workspaces</DialogTitle>
            <DialogDescription>
              Create, edit, and manage your MCP server workspaces
            </DialogDescription>
          </DialogHeader>

          {view === "list" && (
            <div className="flex flex-col gap-4 flex-1 overflow-hidden">
              <div className="flex gap-2">
                <Button
                  onClick={() => setView("create")}
                  className="flex-1"
                  variant="default"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Create Workspace
                </Button>
                <Button onClick={handleImport} variant="outline">
                  <Upload className="h-4 w-4 mr-2" />
                  Import
                </Button>
              </div>

              <ScrollArea className="flex-1">
                <div className="space-y-2 pr-4">
                  {workspaceList.map((workspace) => (
                    <div
                      key={workspace.id}
                      className="p-4 border rounded-lg hover:bg-accent/50 transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold truncate">
                              {workspace.name}
                            </h3>
                            {workspace.id === activeWorkspaceId && (
                              <Badge variant="default" className="text-xs">
                                Active
                              </Badge>
                            )}
                            {workspace.isDefault && (
                              <Badge variant="secondary" className="text-xs">
                                Default
                              </Badge>
                            )}
                          </div>
                          {workspace.description && (
                            <p className="text-sm text-muted-foreground truncate">
                              {workspace.description}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">
                            {Object.keys(workspace.servers).length} server(s)
                          </p>
                        </div>

                        <div className="flex gap-1 ml-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => onSetDefaultWorkspace(workspace.id)}
                            title={
                              workspace.isDefault
                                ? "Unset as default"
                                : "Set as default"
                            }
                          >
                            {workspace.isDefault ? (
                              <Star className="h-4 w-4 fill-current" />
                            ) : (
                              <StarOff className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleStartEdit(workspace)}
                            title="Edit workspace"
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDuplicate(workspace)}
                            title="Duplicate workspace"
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => onExportWorkspace(workspace.id)}
                            title="Export workspace"
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          {workspace.id !== activeWorkspaceId && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDeleteClick(workspace.id)}
                              title="Delete workspace"
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          {view === "create" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="workspace-name">Workspace Name *</Label>
                <Input
                  id="workspace-name"
                  value={newWorkspaceName}
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                  placeholder="e.g., Work, Personal, Development"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="workspace-description">Description</Label>
                <Textarea
                  id="workspace-description"
                  value={newWorkspaceDescription}
                  onChange={(e) => setNewWorkspaceDescription(e.target.value)}
                  placeholder="Optional description for this workspace"
                  rows={3}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setView("list")}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreateWorkspace}
                  disabled={!newWorkspaceName.trim()}
                >
                  Create
                </Button>
              </div>
            </div>
          )}

          {view === "edit" && editingWorkspace && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-workspace-name">Workspace Name *</Label>
                <Input
                  id="edit-workspace-name"
                  value={editingWorkspace.name}
                  onChange={(e) =>
                    setEditingWorkspace({
                      ...editingWorkspace,
                      name: e.target.value,
                    })
                  }
                  placeholder="Workspace name"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-workspace-description">Description</Label>
                <Textarea
                  id="edit-workspace-description"
                  value={editingWorkspace.description || ""}
                  onChange={(e) =>
                    setEditingWorkspace({
                      ...editingWorkspace,
                      description: e.target.value,
                    })
                  }
                  placeholder="Optional description"
                  rows={3}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditingWorkspace(null);
                    setView("list");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleUpdateWorkspace}
                  disabled={!editingWorkspace.name.trim()}
                >
                  Save Changes
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteConfirmId !== null}
        onOpenChange={() => setDeleteConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the workspace and all its server
              configurations. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
