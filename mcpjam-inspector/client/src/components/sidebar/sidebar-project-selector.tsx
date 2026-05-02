import { ChevronsUpDown, Plus, Settings, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { LearnMoreHoverCard } from "@/components/learn-more/LearnMoreHoverCard";
import { Avatar, AvatarFallback, AvatarImage } from "@mcpjam/design-system/avatar";
import { cn, getInitials } from "@/lib/utils";
import { useProjectMembers } from "@/hooks/useProjects";
import { useConvexAuth } from "convex/react";
import type { Project } from "@/state/app-types";
import { resolveProjectIcon } from "@/components/project/ProjectEmojiPicker";

interface SidebarProjectSelectorProps {
  activeProjectId: string;
  projects: Record<string, Project>;
  onSwitchProject: (projectId: string) => void;
  onCreateProject: (name: string, switchTo?: boolean) => Promise<string>;
  onDeleteProject: (projectId: string) => void;
  isLoading?: boolean;
  onNavigateToSettings?: () => void;
  isCreateDisabled?: boolean;
  createDisabledReason?: string;
  onLearnMoreExpand?: (tabId: string, sourceRect: DOMRect | null) => void;
}

interface ProjectDeleteState {
  canDelete: boolean;
  reason: string;
}

function getProjectDeleteState({
  project,
  isAuthenticated,
}: {
  project: Project;
  isAuthenticated: boolean;
}): ProjectDeleteState {
  if (!isAuthenticated || !project.sharedProjectId) {
    return { canDelete: true, reason: "Delete project" };
  }

  if (project.canDeleteProject !== false) {
    return { canDelete: true, reason: "Delete project" };
  }

  return {
    canDelete: false,
    reason: "Only project admins can delete this project",
  };
}

export function SidebarProjectSelector({
  activeProjectId,
  projects,
  onSwitchProject,
  onCreateProject,
  onDeleteProject,
  isLoading,
  onNavigateToSettings,
  isCreateDisabled = false,
  createDisabledReason,
  onLearnMoreExpand,
}: SidebarProjectSelectorProps) {
  const { isMobile } = useSidebar();
  const { isAuthenticated } = useConvexAuth();

  const activeProject = projects[activeProjectId];
  const sharedProjectId = activeProject?.sharedProjectId ?? null;

  const { activeMembers } = useProjectMembers({
    isAuthenticated,
    projectId: sharedProjectId,
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

  const projectName = activeProject?.name || "No Project";
  const initial = projectName.charAt(0).toUpperCase();
  const displayMembers = activeMembers.slice(0, 3);
  const projectList = Object.values(projects).sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });

  const handleCreateProject = () => {
    if (isCreateDisabled) {
      return;
    }
    let baseName = "New project";
    let name = baseName;
    let counter = 1;
    const projectNames = Object.values(projects).map((w) =>
      w.name.toLowerCase(),
    );
    while (projectNames.includes(name.toLowerCase())) {
      counter++;
      name = `${baseName} ${counter}`;
    }
    onCreateProject(name, true);
  };

  const createProjectItem = (
    <DropdownMenuItem
      onClick={handleCreateProject}
      disabled={isCreateDisabled}
      title={createDisabledReason}
      className={cn("cursor-pointer", isCreateDisabled && "cursor-not-allowed")}
    >
      <Plus className="size-4" />
      Add Project
    </DropdownMenuItem>
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          {onLearnMoreExpand ? (
            <LearnMoreHoverCard tabId="projects" onExpand={onLearnMoreExpand}>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <ProjectIconBadge
                    icon={activeProject?.icon}
                    fallback={initial}
                    size={8}
                  />
                  <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                    <span className="truncate font-semibold">
                      {projectName}
                    </span>
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
            </LearnMoreHoverCard>
          ) : (
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <ProjectIconBadge
                  icon={activeProject?.icon}
                  fallback={initial}
                  size={8}
                />
                <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                  <span className="truncate font-semibold">
                    {projectName}
                  </span>
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
          )}
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="start"
            sideOffset={4}
          >
            {projectList.map((project) => (
              <DropdownMenuItem
                key={project.id}
                className={cn(
                  "cursor-pointer group/item flex items-center justify-between",
                  project.id === activeProjectId && "bg-accent",
                )}
                onClick={() => onSwitchProject(project.id)}
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <ProjectIconBadge
                    icon={project.icon}
                    fallback={project.name.charAt(0).toUpperCase()}
                    size={6}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="truncate block">{project.name}</span>
                  </div>
                </div>
                {!project.isDefault && (
                  <ProjectDeleteButton
                    project={project}
                    deleteState={getProjectDeleteState({
                      project,
                      isAuthenticated,
                    })}
                    onDeleteProject={onDeleteProject}
                  />
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {isCreateDisabled && createDisabledReason ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex" title={createDisabledReason}>
                    {createProjectItem}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {createDisabledReason}
                </TooltipContent>
              </Tooltip>
            ) : (
              createProjectItem
            )}
            {onNavigateToSettings && (
              <DropdownMenuItem
                onClick={onNavigateToSettings}
                className="cursor-pointer"
              >
                <Settings className="size-4" />
                Project Settings
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function ProjectDeleteButton({
  project,
  deleteState,
  onDeleteProject,
}: {
  project: Project;
  deleteState: ProjectDeleteState;
  onDeleteProject: (projectId: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
        >
          <button
            type="button"
            disabled={!deleteState.canDelete}
            aria-label={`Delete project ${project.name}`}
            title={deleteState.reason}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              if (!deleteState.canDelete) return;
              onDeleteProject(project.id);
            }}
            className={cn(
              "opacity-0 group-hover/item:opacity-100 transition-opacity p-1",
              deleteState.canDelete
                ? "hover:text-destructive"
                : "cursor-not-allowed text-muted-foreground/70",
            )}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{deleteState.reason}</TooltipContent>
    </Tooltip>
  );
}

function ProjectIconBadge({
  icon,
  fallback,
  size,
}: {
  icon?: string;
  fallback: string;
  size: 6 | 8;
}) {
  const IconComponent = icon ? resolveProjectIcon(icon) : null;
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
