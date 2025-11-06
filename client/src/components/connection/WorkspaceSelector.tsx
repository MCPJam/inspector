import { Check, ChevronDown, Settings, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Workspace } from "@/state/app-types";

interface WorkspaceSelectorProps {
  activeWorkspaceId: string;
  workspaces: Record<string, Workspace>;
  onSwitchWorkspace: (workspaceId: string) => void;
  onManageWorkspaces: () => void;
}

export function WorkspaceSelector({
  activeWorkspaceId,
  workspaces,
  onSwitchWorkspace,
  onManageWorkspaces,
}: WorkspaceSelectorProps) {
  const activeWorkspace = workspaces[activeWorkspaceId];
  const workspaceList = Object.values(workspaces).sort((a, b) => {
    // Default workspace first
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    // Then sort by name
    return a.name.localeCompare(b.name);
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="w-[200px] justify-start">
          <User className="mr-2 h-4 w-4" />
          <span className="truncate">{activeWorkspace?.name || "No Workspace"}</span>
          <ChevronDown className="ml-auto h-4 w-4 opacity-50" />
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
            <Check
              className={cn(
                "mr-2 h-4 w-4",
                workspace.id === activeWorkspaceId ? "opacity-100" : "opacity-0"
              )}
            />
            <span className="truncate flex-1">{workspace.name}</span>
            {workspace.isDefault && (
              <Badge variant="secondary" className="ml-2 text-xs">
                Default
              </Badge>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onManageWorkspaces} className="cursor-pointer">
          <Settings className="mr-2 h-4 w-4" />
          Manage Workspaces
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
