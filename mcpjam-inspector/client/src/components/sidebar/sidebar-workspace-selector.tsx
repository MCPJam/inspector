import { ChevronsUpDown, Plus, Settings, Trash2 } from "lucide-react";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, getInitials } from "@/lib/utils";
import { useWorkspaceMembers } from "@/hooks/useWorkspaces";
import { useConvexAuth } from "convex/react";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import type { Workspace } from "@/state/app-types";
import { resolveWorkspaceIcon } from "@/components/workspace/WorkspaceEmojiPicker";

interface SidebarWorkspaceSelectorProps {
  activeWorkspaceId: string;
  workspaces: Record<string, Workspace>;
  onSwitchWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: (name: string, switchTo?: boolean) => Promise<string>;
  onDeleteWorkspace: (workspaceId: string) => void;
  isLoading?: boolean;
  onNavigateToSettings?: () => void;
}

export function SidebarWorkspaceSelector({
  activeWorkspaceId,
  workspaces,
  onSwitchWorkspace,
  onCreateWorkspace,
  onDeleteWorkspace,
  isLoading,
  onNavigateToSettings,
}: SidebarWorkspaceSelectorProps) {
  const { isMobile } = useSidebar();
  const { isAuthenticated } = useConvexAuth();
  const { profilePictureUrl } = useProfilePicture();

  const activeWorkspace = workspaces[activeWorkspaceId];
  const sharedWorkspaceId = activeWorkspace?.sharedWorkspaceId ?? null;

  const { activeMembers } = useWorkspaceMembers({
    isAuthenticated,
    workspaceId: sharedWorkspaceId,
  });

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

  const workspaceName = activeWorkspace?.name || "No Workspace";
  const initial = workspaceName.charAt(0).toUpperCase();
  const displayMembers = activeMembers.slice(0, 3);
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
              <WorkspaceIconBadge icon={activeWorkspace?.icon} fallback={initial} size={8} />
              <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate font-semibold">{workspaceName}</span>
                {displayMembers.length > 0 && (
                  <div className="flex -space-x-1.5 mt-0.5">
                    {displayMembers.map((member) => {
                      const name = member.user?.name || member.email;
                      const initials = getInitials(name);
                      return (
                        <Avatar
                          key={member._id}
                          className="size-5 border border-sidebar-background"
                        >
                          <AvatarImage
                            src={member.user?.imageUrl || undefined}
                            alt={name}
                          />
                          <AvatarFallback className="text-[8px] bg-muted">
                            {initials}
                          </AvatarFallback>
                        </Avatar>
                      );
                    })}
                    {activeMembers.length > 3 && (
                      <div className="size-5 rounded-full border border-sidebar-background bg-muted flex items-center justify-center">
                        <span className="text-[8px] text-muted-foreground font-medium">
                          +{activeMembers.length - 3}
                        </span>
                      </div>
                    )}
                  </div>
                )}
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
                  <WorkspaceIconBadge icon={workspace.icon} fallback={workspace.name.charAt(0).toUpperCase()} size={6} />
                  <div className="min-w-0 flex-1">
                    <span className="truncate block">{workspace.name}</span>
                  </div>
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
            {onNavigateToSettings && (
              <DropdownMenuItem
                onClick={onNavigateToSettings}
                className="cursor-pointer"
              >
                <Settings className="size-4" />
                Workspace Settings
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function WorkspaceIconBadge({
  icon,
  fallback,
  size,
}: {
  icon?: string;
  fallback: string;
  size: 6 | 8;
}) {
  const IconComponent = icon ? resolveWorkspaceIcon(icon) : null;
  const sizeClass = size === 8 ? "size-8 rounded-lg" : "size-6 rounded";
  const iconSize = size === 8 ? "h-4 w-4" : "h-3.5 w-3.5";
  return (
    <div
      className={`flex items-center justify-center ${sizeClass} bg-primary/10 text-primary text-${size === 8 ? "sm" : "xs"} font-semibold shrink-0`}
    >
      {IconComponent ? (
        <IconComponent className={iconSize} strokeWidth={1.5} />
      ) : (
        fallback
      )}
    </div>
  );
}
