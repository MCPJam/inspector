import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { EditableText } from "@/components/ui/editable-text";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { cn } from "@/lib/utils";
import { Project } from "@/state/app-types";

interface ProjectSelectorProps {
  activeProjectId: string;
  projects: Record<string, Project>;
  onSwitchProject: (projectId: string) => void;
  onCreateProject: (name: string, switchTo?: boolean) => Promise<string>;
  onUpdateProject: (projectId: string, updates: Partial<Project>) => void;
  onDeleteProject: (projectId: string) => void;
  isLoading?: boolean;
}

export function ProjectSelector({
  activeProjectId,
  projects,
  onSwitchProject,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  isLoading,
}: ProjectSelectorProps) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-1">
        <Skeleton className="h-8 w-32" />
      </div>
    );
  }

  const activeProject = projects[activeProjectId];

  const projectList = Object.values(projects).sort((a, b) => {
    // Default project first
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    // Then sort by name
    return a.name.localeCompare(b.name);
  });

  const handleCreateProject = () => {
    // Find a unique name for "New project"
    let baseName = "New project";
    let name = baseName;
    let counter = 1;

    // Check if a project with this name already exists
    const projectNames = Object.values(projects).map((w) =>
      w.name.toLowerCase(),
    );
    while (projectNames.includes(name.toLowerCase())) {
      counter++;
      name = `${baseName} ${counter}`;
    }

    // Create and switch to the new project
    onCreateProject(name, true);
  };

  const handleSaveName = (name: string) => {
    onUpdateProject(activeProjectId, { name });
  };

  return (
    <div className="flex items-center gap-1">
      {/* Editable project name */}
      <EditableText
        value={activeProject?.name || "No Project"}
        onSave={handleSaveName}
        className="px-3 py-2 text-2xl font-bold tracking-tight"
        placeholder="Project name"
      />

      {/* Dropdown menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-auto p-1">
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[240px]">
          {projectList.map((project) => (
            <DropdownMenuItem
              key={project.id}
              className={cn(
                "cursor-pointer group flex items-center justify-between",
                project.id === activeProjectId && "bg-accent",
              )}
              onClick={() => onSwitchProject(project.id)}
            >
              <span className="truncate flex-1">{project.name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  onDeleteProject(project.id);
                }}
                className="opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity p-1"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleCreateProject}
            className="cursor-pointer"
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
