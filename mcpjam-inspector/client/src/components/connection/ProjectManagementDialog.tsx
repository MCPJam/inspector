import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
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
import { Project } from "@/state/app-types";
import { Badge } from "@mcpjam/design-system/badge";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";

interface ProjectManagementDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projects: Record<string, Project>;
  activeProjectId: string;
  onCreateProject: (name: string, description?: string) => void;
  onUpdateProject: (projectId: string, updates: Partial<Project>) => void;
  onDeleteProject: (projectId: string) => void;
  onDuplicateProject: (projectId: string, newName: string) => void;
  onSetDefaultProject: (projectId: string) => void;
  onExportProject: (projectId: string) => void;
  onImportProject: (projectData: Project) => void;
}

export function ProjectManagementDialog({
  isOpen,
  onClose,
  projects,
  activeProjectId,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  onDuplicateProject,
  onSetDefaultProject,
  onExportProject,
  onImportProject,
}: ProjectManagementDialogProps) {
  const [view, setView] = useState<"list" | "create" | "edit">("list");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDescription, setNewProjectDescription] = useState("");
  const [editingProject, setEditingProject] = useState<Project | null>(
    null,
  );
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const projectList = Object.values(projects).sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });

  const handleCreateProject = () => {
    if (newProjectName.trim()) {
      onCreateProject(
        newProjectName.trim(),
        newProjectDescription.trim() || undefined,
      );
      setNewProjectName("");
      setNewProjectDescription("");
      setView("list");
    }
  };

  const handleUpdateProject = () => {
    if (editingProject && editingProject.name.trim()) {
      onUpdateProject(editingProject.id, {
        name: editingProject.name.trim(),
        description: editingProject.description?.trim() || undefined,
      });
      setEditingProject(null);
      setView("list");
    }
  };

  const handleStartEdit = (project: Project) => {
    setEditingProject({ ...project });
    setView("edit");
  };

  const handleDeleteClick = (projectId: string) => {
    setDeleteConfirmId(projectId);
  };

  const handleConfirmDelete = () => {
    if (deleteConfirmId) {
      onDeleteProject(deleteConfirmId);
      setDeleteConfirmId(null);
    }
  };

  const handleDuplicate = (project: Project) => {
    const newName = `${project.name} (Copy)`;
    onDuplicateProject(project.id, newName);
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
          const projectData = JSON.parse(text);
          onImportProject(projectData);
        } catch (error) {
          console.error("Failed to import project:", error);
          alert("Failed to import project. Please check the file format.");
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
            <DialogTitle>Manage Projects</DialogTitle>
            <DialogDescription>
              Create, edit, and manage your MCP server projects
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
                  Create Project
                </Button>
                <Button onClick={handleImport} variant="outline">
                  <Upload className="h-4 w-4 mr-2" />
                  Import
                </Button>
              </div>

              <ScrollArea className="flex-1">
                <div className="space-y-2 pr-4">
                  {projectList.map((project) => (
                    <div
                      key={project.id}
                      className="p-4 border rounded-lg hover:bg-accent/50 transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold truncate">
                              {project.name}
                            </h3>
                            {project.id === activeProjectId && (
                              <Badge variant="default" className="text-xs">
                                Active
                              </Badge>
                            )}
                            {project.isDefault && (
                              <Badge variant="secondary" className="text-xs">
                                Default
                              </Badge>
                            )}
                          </div>
                          {project.description && (
                            <p className="text-sm text-muted-foreground truncate">
                              {project.description}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">
                            {Object.keys(project.servers).length} server(s)
                          </p>
                        </div>

                        <div className="flex gap-1 ml-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => onSetDefaultProject(project.id)}
                            title={
                              project.isDefault
                                ? "Unset as default"
                                : "Set as default"
                            }
                          >
                            {project.isDefault ? (
                              <Star className="h-4 w-4 fill-current" />
                            ) : (
                              <StarOff className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleStartEdit(project)}
                            title="Edit project"
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDuplicate(project)}
                            title="Duplicate project"
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => onExportProject(project.id)}
                            title="Export project"
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          {project.id !== activeProjectId && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDeleteClick(project.id)}
                              title="Delete project"
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
                <Label htmlFor="project-name">Project Name *</Label>
                <Input
                  id="project-name"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="e.g., Work, Personal, Development"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="project-description">Description</Label>
                <Textarea
                  id="project-description"
                  value={newProjectDescription}
                  onChange={(e) => setNewProjectDescription(e.target.value)}
                  placeholder="Optional description for this project"
                  rows={3}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setView("list")}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreateProject}
                  disabled={!newProjectName.trim()}
                >
                  Create
                </Button>
              </div>
            </div>
          )}

          {view === "edit" && editingProject && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-project-name">Project Name *</Label>
                <Input
                  id="edit-project-name"
                  value={editingProject.name}
                  onChange={(e) =>
                    setEditingProject({
                      ...editingProject,
                      name: e.target.value,
                    })
                  }
                  placeholder="Project name"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-project-description">Description</Label>
                <Textarea
                  id="edit-project-description"
                  value={editingProject.description || ""}
                  onChange={(e) =>
                    setEditingProject({
                      ...editingProject,
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
                    setEditingProject(null);
                    setView("list");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleUpdateProject}
                  disabled={!editingProject.name.trim()}
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
            <AlertDialogTitle>Delete Project?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the project and all its server
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
