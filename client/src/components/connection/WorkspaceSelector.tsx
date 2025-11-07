import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Workspace } from "@/state/app-types";
import { useState } from "react";

interface WorkspaceSelectorProps {
  activeWorkspaceId: string;
  workspaces: Record<string, Workspace>;
  onSwitchWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: (name: string) => void;
  onUpdateWorkspace: (workspaceId: string, updates: Partial<Workspace>) => void;
}

export function WorkspaceSelector({
  activeWorkspaceId,
  workspaces,
  onSwitchWorkspace,
  onCreateWorkspace,
  onUpdateWorkspace,
}: WorkspaceSelectorProps) {
  const activeWorkspace = workspaces[activeWorkspaceId];
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState(activeWorkspace?.name || "");

  const workspaceList = Object.values(workspaces).sort((a, b) => {
    // Default workspace first
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    // Then sort by name
    return a.name.localeCompare(b.name);
  });

  const handleCreateWorkspace = () => {
    const name = prompt("Enter workspace name:");
    if (name && name.trim()) {
      onCreateWorkspace(name.trim());
    }
  };

  const handleNameClick = () => {
    setIsEditing(true);
    setEditedName(activeWorkspace?.name || "");
  };

  const handleNameBlur = () => {
    setIsEditing(false);
    if (editedName.trim() && editedName !== activeWorkspace?.name) {
      onUpdateWorkspace(activeWorkspaceId, { name: editedName.trim() });
    } else {
      setEditedName(activeWorkspace?.name || "");
    }
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleNameBlur();
    } else if (e.key === "Escape") {
      setIsEditing(false);
      setEditedName(activeWorkspace?.name || "");
    }
  };

  return (
    <div className="flex items-center gap-1">
      {/* Editable workspace name */}
      {isEditing ? (
        <input
          type="text"
          value={editedName}
          onChange={(e) => setEditedName(e.target.value)}
          onBlur={handleNameBlur}
          onKeyDown={handleNameKeyDown}
          autoFocus
          className="px-3 py-1.5 text-sm font-medium border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
        />
      ) : (
        <Button
          variant="ghost"
          onClick={handleNameClick}
          className="px-3 py-1.5 h-auto font-medium hover:bg-accent"
        >
          {activeWorkspace?.name || "No Workspace"}
        </Button>
      )}

      {/* Dropdown menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-auto p-1">
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[200px]">
          {workspaceList.map((workspace) => (
            <DropdownMenuItem
              key={workspace.id}
              onClick={() => onSwitchWorkspace(workspace.id)}
              className={cn(
                "cursor-pointer",
                workspace.id === activeWorkspaceId && "bg-accent"
              )}
            >
              <span className="truncate flex-1">{workspace.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleCreateWorkspace} className="cursor-pointer">
            <Plus className="mr-2 h-4 w-4" />
            Add Workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
