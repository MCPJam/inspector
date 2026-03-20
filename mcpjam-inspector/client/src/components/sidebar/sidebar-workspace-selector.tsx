import { ChevronsUpDown, Plus, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/state/app-types";

interface SidebarWorkspaceSelectorProps {
  activeWorkspaceId: string;
  workspaces: Record<string, Workspace>;
  onSwitchWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: (name: string, switchTo?: boolean) => Promise<string>;
  onDeleteWorkspace: (workspaceId: string) => void;
  isLoading?: boolean;
}

export function SidebarWorkspaceSelector({
  activeWorkspaceId,
  workspaces,
  onSwitchWorkspace,
  onCreateWorkspace,
  onDeleteWorkspace,
  isLoading,
}: SidebarWorkspaceSelectorProps) {
  const { isMobile } = useSidebar();

  if (isLoading) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" disabled>
            <Skeleton className="size-8 rounded-lg" />
            <Skeleton className="h-4 w-24 group-data-[collapsible=icon]:hidden" />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const activeWorkspace = workspaces[activeWorkspaceId];
  const workspaceName = activeWorkspace?.name || "No Workspace";
  const initial = workspaceName.charAt(0).toUpperCase();

  const workspaceList = Object.values(workspaces).sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });

  const handleCreateWorkspace = () => {
    let baseName = "New workspace";
    let name = baseName;
    let counter = 1;
    const workspaceNames = Object.values(workspaces).map((w) =>
      w.name.toLowerCase(),
    );
    while (workspaceNames.includes(name.toLowerCase())) {
      counter++;
      name = `${baseName} ${counter}`;
    }
    onCreateWorkspace(name, true);
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex items-center justify-center size-8 rounded-lg bg-primary/10 text-primary text-sm font-semibold shrink-0">
                {initial}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate font-semibold">{workspaceName}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="start"
            sideOffset={4}
          >
            {workspaceList.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                className={cn(
                  "cursor-pointer group/item flex items-center justify-between",
                  workspace.id === activeWorkspaceId && "bg-accent",
                )}
                onClick={() => onSwitchWorkspace(workspace.id)}
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div className="flex items-center justify-center size-6 rounded bg-primary/10 text-primary text-xs font-semibold shrink-0">
                    {workspace.name.charAt(0).toUpperCase()}
                  </div>
                  <span className="truncate flex-1">{workspace.name}</span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onDeleteWorkspace(workspace.id);
                  }}
                  className="opacity-0 group-hover/item:opacity-100 hover:text-destructive transition-opacity p-1"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleCreateWorkspace}
              className="cursor-pointer"
            >
              <Plus className="size-4" />
              Add Workspace
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
