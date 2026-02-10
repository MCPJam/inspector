import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EditableText } from "@/components/ui/editable-text";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Workspace } from "@/state/app-types";

interface WorkspaceSelectorProps {
  activeWorkspaceId: string;
  workspaces: Record<string, Workspace>;
  onSwitchWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: (name: string, switchTo?: boolean) => Promise<string>;
  onUpdateWorkspace: (workspaceId: string, updates: Partial<Workspace>) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  isLoading?: boolean;
}

export function WorkspaceSelector({
  activeWorkspaceId,
  workspaces,
  onSwitchWorkspace,
  onCreateWorkspace,
  onUpdateWorkspace,
  onDeleteWorkspace,
  isLoading,
}: WorkspaceSelectorProps) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-1">
        <Skeleton className="h-8 w-32" />
      </div>
    );
  }

  const activeWorkspace = workspaces[activeWorkspaceId];

  const workspaceList = Object.values(workspaces).sort((a, b) => {
    // Default workspace first
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    // Then sort by name
    return a.name.localeCompare(b.name);
  });

  const handleCreateWorkspace = () => {
    // Find a unique name for "New workspace"
    let baseName = "New workspace";
    let name = baseName;
    let counter = 1;

    // Check if a workspace with this name already exists
    const workspaceNames = Object.values(workspaces).map((w) =>
      w.name.toLowerCase(),
    );
    while (workspaceNames.includes(name.toLowerCase())) {
      counter++;
      name = `${baseName} ${counter}`;
    }

    // Create and switch to the new workspace
    onCreateWorkspace(name, true);
  };

  const handleSaveName = (name: string) => {
    onUpdateWorkspace(activeWorkspaceId, { name });
  };

  return (
    <div className="flex items-center gap-1">
      {/* Editable workspace name */}
      <EditableText
        value={activeWorkspace?.name || "No Workspace"}
        onSave={handleSaveName}
        className="px-3 py-2 text-2xl font-bold tracking-tight"
        placeholder="Workspace name"
      />

      {/* Dropdown menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-auto p-1">
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[240px]">
          {workspaceList.map((workspace) => (
            <DropdownMenuItem
              key={workspace.id}
              className={cn(
                "cursor-pointer group flex items-center justify-between",
                workspace.id === activeWorkspaceId && "bg-accent",
              )}
              onClick={() => onSwitchWorkspace(workspace.id)}
            >
              <span className="truncate flex-1">{workspace.name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  onDeleteWorkspace(workspace.id);
                }}
                className="opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity p-1"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleCreateWorkspace}
            className="cursor-pointer"
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
