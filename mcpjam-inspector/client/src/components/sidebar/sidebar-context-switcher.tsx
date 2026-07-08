import { useState, useMemo, useEffect } from "react";
import {
  ArrowLeftRight,
  Building2,
  ChevronDown,
  ChevronsUpDown,
  LogIn,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { useAuth } from "@workos-inc/authkit-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@mcpjam/design-system/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
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
import { cn, getInitials } from "@/lib/utils";
import { useProjectMembers } from "@/hooks/useProjects";
import { useOrganizationQueries } from "@/hooks/useOrganizations";
import { useConvexAuth } from "convex/react";
import type { Project } from "@/state/app-types";
import { resolveProjectIcon } from "@/components/project/ProjectEmojiPicker";
import { CreateOrganizationDialog } from "@/components/organization/CreateOrganizationDialog";
import { SidebarCreditUsage } from "@/components/sidebar/sidebar-credit-usage";
import type { OrganizationRouteSection } from "@/lib/app-navigation";

interface SidebarContextSwitcherProps {
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
  activeOrganizationId?: string;
  /**
   * Navigates to an organization's overview/billing page.
   * Used by the footer org row's gear and the per-row gear in the switch list.
   */
  onSwitchOrganization?: (
    organizationId: string,
    section?: OrganizationRouteSection
  ) => void;
  /**
   * Switches the active organization context globally without navigating away from
   * the current page. The rest of the app re-renders with the new org's data and
   * the sidebar skeleton kicks in until projects are refetched.
   */
  onSwitchActiveOrganization?: (organizationId: string) => void;
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

const ORG_TINTS: Array<{ bg: string; fg: string }> = [
  { bg: "bg-blue-500/15", fg: "text-blue-700 dark:text-blue-300" },
  { bg: "bg-violet-500/15", fg: "text-violet-700 dark:text-violet-300" },
  { bg: "bg-emerald-500/15", fg: "text-emerald-700 dark:text-emerald-300" },
  { bg: "bg-amber-500/15", fg: "text-amber-700 dark:text-amber-300" },
  { bg: "bg-rose-500/15", fg: "text-rose-700 dark:text-rose-300" },
  { bg: "bg-cyan-500/15", fg: "text-cyan-700 dark:text-cyan-300" },
];

function getOrgTint(orgId: string): { bg: string; fg: string } {
  let hash = 0;
  for (let i = 0; i < orgId.length; i++) {
    hash = (hash * 31 + orgId.charCodeAt(i)) | 0;
  }
  return ORG_TINTS[Math.abs(hash) % ORG_TINTS.length];
}

const SECTION_LABEL_CLASS = "text-[11px] font-semibold text-foreground";

export function SidebarContextSwitcher({
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
  activeOrganizationId,
  onSwitchOrganization,
  onSwitchActiveOrganization,
}: SidebarContextSwitcherProps) {
  const { isMobile } = useSidebar();
  const { isAuthenticated } = useConvexAuth();
  const { user, signIn } = useAuth();
  const { sortedOrganizations, canCreateOrganization } = useOrganizationQueries(
    { isAuthenticated }
  );
  const showSignInChip = !user;

  const [menuOpen, setMenuOpen] = useState(false);
  const [orgListOpen, setOrgListOpen] = useState(false);
  const [showCreateOrgDialog, setShowCreateOrgDialog] = useState(false);

  // Switching orgs is rare; start every menu open on the common case (projects).
  useEffect(() => {
    setOrgListOpen(false);
  }, [menuOpen]);

  const activeProject = projects[activeProjectId];

  const activeOrg = useMemo(
    () => sortedOrganizations.find((o) => o._id === activeOrganizationId),
    [sortedOrganizations, activeOrganizationId]
  );

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

  const projectsList = Object.values(projects);
  const activeOrgTint = activeOrg ? getOrgTint(activeOrg._id) : undefined;
  const activeOrgProjects = projectsList
    .filter((p) => {
      if (!activeOrganizationId) return !p.organizationId;
      return p.organizationId === activeOrganizationId;
    })
    .sort((a, b) => {
      if (a.isDefault) return -1;
      if (b.isDefault) return 1;
      return a.name.localeCompare(b.name);
    });

  // Membership in >1 org (e.g. invited to an external one) is what makes
  // switching meaningful; with a single org we render context only.
  const canSwitchOrganizations = sortedOrganizations.length > 1;

  const handleCreateProject = () => {
    if (isCreateDisabled) return;
    const baseName = "New project";
    let name = baseName;
    let counter = 1;
    const projectNames = projectsList.map((p) => p.name.toLowerCase());
    while (projectNames.includes(name.toLowerCase())) {
      counter++;
      name = `${baseName} ${counter}`;
    }
    onCreateProject(name, true);
  };

  const openCreateOrgDialog = () => {
    setShowCreateOrgDialog(true);
    setMenuOpen(false);
  };

  const newOrganizationRow = canCreateOrganization ? (
    <button
      type="button"
      aria-label="New organization"
      onClick={openCreateOrgDialog}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
    >
      <div className="flex items-center justify-center size-5 rounded bg-muted shrink-0">
        <Plus className="size-3" />
      </div>
      <span className="flex-1 truncate text-left font-medium">
        New organization
      </span>
    </button>
  ) : null;

  const triggerButton = (
    <SidebarMenuButton
      size="lg"
      title={activeOrg ? `${activeOrg.name} / ${projectName}` : projectName}
      aria-label={
        activeOrg
          ? `Switch context: ${activeOrg.name} / ${projectName}`
          : `Switch project: ${projectName}`
      }
      className="h-10 p-1.5 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
    >
      <ProjectIconBadge
        icon={activeProject?.icon}
        fallback={initial}
        size={8}
      />
      <div className="grid flex-1 text-left text-xs leading-tight group-data-[collapsible=icon]:hidden min-w-0">
        <span className="truncate font-semibold">{projectName}</span>
        {activeOrg ? (
          <span className="truncate text-xs text-muted-foreground">
            {activeOrg.name}
          </span>
        ) : null}
      </div>
      <ChevronsUpDown className="ml-auto size-4 group-data-[collapsible=icon]:hidden" />
    </SidebarMenuButton>
  );

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            {onLearnMoreExpand ? (
              <LearnMoreHoverCard tabId="projects" onExpand={onLearnMoreExpand}>
                <DropdownMenuTrigger asChild>
                  {triggerButton}
                </DropdownMenuTrigger>
              </LearnMoreHoverCard>
            ) : (
              <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
            )}
            <DropdownMenuContent
              className="w-[300px] rounded-xl p-0 shadow-md bg-sidebar"
              side={isMobile ? "bottom" : "right"}
              align="start"
              sideOffset={4}
            >
              {/* Projects section — the frequent operation owns the body */}
              <div className="px-1.5 pt-2 pb-1">
                <div className="flex items-center justify-between px-2 pb-1.5">
                  <span className={SECTION_LABEL_CLASS}>Projects</span>
                  {isCreateDisabled && createDisabledReason ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex">
                          <button
                            type="button"
                            disabled
                            aria-disabled="true"
                            aria-label="Add project"
                            title={createDisabledReason}
                            className="p-0.5 rounded text-muted-foreground/40 cursor-not-allowed"
                          >
                            <Plus className="size-3.5" />
                          </button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        {createDisabledReason}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <button
                      type="button"
                      aria-label="Add project"
                      title="Add project"
                      onClick={() => {
                        handleCreateProject();
                        setMenuOpen(false);
                      }}
                      className="p-0.5 rounded text-muted-foreground/70 hover:text-foreground hover:bg-muted transition-colors"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  )}
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {activeOrgProjects.length === 0 ? (
                    <div className="px-2 py-3 text-xs text-muted-foreground">
                      No projects in this organization
                    </div>
                  ) : (
                    activeOrgProjects.map((project) => (
                      <ProjectRow
                        key={project.id}
                        project={project}
                        isActive={project.id === activeProjectId}
                        isAuthenticated={isAuthenticated}
                        onClick={() => {
                          onSwitchProject(project.id);
                          setMenuOpen(false);
                        }}
                        onOpenSettings={
                          onNavigateToSettings
                            ? async () => {
                                setMenuOpen(false);
                                if (project.id !== activeProjectId) {
                                  await onSwitchProject(project.id);
                                }
                                onNavigateToSettings();
                              }
                            : undefined
                        }
                        onDeleteProject={onDeleteProject}
                      />
                    ))
                  )}
                </div>
              </div>

              {/* Inset hairline divider */}
              <div className="mx-3 my-0.5 h-px bg-border/70" />

              {/* Org footer — ambient context, not a destination */}
              <div className="px-1.5 pt-1 pb-1.5">
                {showSignInChip ? (
                  <button
                    type="button"
                    data-testid="org-sign-in-button"
                    onClick={() => {
                      signIn();
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent transition-colors"
                  >
                    <div className="flex items-center justify-center size-6 rounded-md bg-primary/10 text-primary shrink-0">
                      <LogIn className="size-3.5" />
                    </div>
                    <span className="flex-1 min-w-0 text-[13px] font-medium truncate">
                      Sign in
                    </span>
                  </button>
                ) : (
                  <>
                    <div
                      data-testid="org-context-row"
                      className="group/orgrow flex items-center gap-2.5 rounded-lg px-2 py-1.5"
                    >
                      {activeOrg ? (
                        <div
                          className={cn(
                            "flex items-center justify-center size-6 rounded-md text-[11px] font-semibold shrink-0",
                            activeOrgTint!.bg,
                            activeOrgTint!.fg
                          )}
                        >
                          {activeOrg.name.charAt(0).toUpperCase()}
                        </div>
                      ) : (
                        <div className="flex items-center justify-center size-6 rounded-md bg-muted text-muted-foreground shrink-0">
                          <Building2 className="size-3.5" />
                        </div>
                      )}
                      <span className="flex-1 min-w-0 text-[13px] font-medium truncate">
                        {activeOrg?.name ?? "No organization"}
                      </span>
                      {activeOrg && onSwitchOrganization ? (
                        <button
                          type="button"
                          aria-label={`Open ${activeOrg.name} settings`}
                          title={`Open ${activeOrg.name} settings`}
                          onClick={() => {
                            onSwitchOrganization(activeOrg._id, "overview");
                            setMenuOpen(false);
                          }}
                          className="p-0.5 rounded text-muted-foreground/70 hover:text-foreground hover:bg-muted transition-colors opacity-0 group-hover/orgrow:opacity-100 group-focus-within/orgrow:opacity-100"
                        >
                          <Settings className="size-3.5" />
                        </button>
                      ) : null}
                    </div>

                    {/* Active org's shared credit usage, right below the org name */}
                    {activeOrganizationId ? (
                      <div className="px-0.5 pt-1">
                        <SidebarCreditUsage
                          variant="full"
                          organizationId={activeOrganizationId}
                          onClick={
                            activeOrg && onSwitchOrganization
                              ? () => {
                                  onSwitchOrganization(
                                    activeOrg._id,
                                    "billing"
                                  );
                                  setMenuOpen(false);
                                }
                              : undefined
                          }
                        />
                      </div>
                    ) : null}

                    {canSwitchOrganizations ? (
                      <button
                        type="button"
                        data-testid="switch-org-button"
                        aria-expanded={orgListOpen}
                        onClick={() => setOrgListOpen((o) => !o)}
                        className="mt-0.5 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
                      >
                        <div className="flex items-center justify-center size-5 rounded bg-muted shrink-0">
                          <ArrowLeftRight className="size-3" />
                        </div>
                        <span className="flex-1 truncate text-left font-medium">
                          Switch organization
                        </span>
                        <ChevronDown
                          aria-hidden="true"
                          className={cn(
                            "size-3.5 shrink-0 transition-transform",
                            orgListOpen && "rotate-180"
                          )}
                        />
                      </button>
                    ) : null}

                    {canSwitchOrganizations && orgListOpen ? (
                      <div data-testid="org-switch-list" className="mt-0.5">
                        {sortedOrganizations.map((org) => {
                          const tint = getOrgTint(org._id);
                          return (
                            <div
                              key={org._id}
                              role="menuitem"
                              tabIndex={0}
                              data-testid={`org-row-${org._id}`}
                              onClick={() => {
                                if (org._id !== activeOrganizationId) {
                                  onSwitchActiveOrganization?.(org._id);
                                }
                                setMenuOpen(false);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  if (org._id !== activeOrganizationId) {
                                    onSwitchActiveOrganization?.(org._id);
                                  }
                                  setMenuOpen(false);
                                }
                              }}
                              className={cn(
                                "group/org flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] cursor-pointer",
                                org._id === activeOrganizationId
                                  ? "bg-accent"
                                  : "hover:bg-accent/60"
                              )}
                            >
                              <div
                                className={cn(
                                  "flex items-center justify-center size-5 rounded text-[10px] font-semibold shrink-0",
                                  tint.bg,
                                  tint.fg
                                )}
                              >
                                {org.name.charAt(0).toUpperCase()}
                              </div>
                              <span className="flex-1 truncate font-medium">
                                {org.name}
                              </span>
                              {onSwitchOrganization ? (
                                <button
                                  type="button"
                                  aria-label={`Open ${org.name} settings`}
                                  title={`Open ${org.name} settings`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onSwitchOrganization(org._id, "overview");
                                    setMenuOpen(false);
                                  }}
                                  className="p-0.5 rounded text-muted-foreground/70 hover:text-foreground hover:bg-muted transition-colors opacity-0 group-hover/org:opacity-100 group-focus-within/org:opacity-100"
                                >
                                  <Settings className="size-3.5" />
                                </button>
                              ) : null}
                            </div>
                          );
                        })}
                        {newOrganizationRow}
                      </div>
                    ) : null}

                    {/* No second org to switch to: surface create directly
                        (only renders for users who don't already own one). */}
                    {!canSwitchOrganizations ? newOrganizationRow : null}
                  </>
                )}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      <CreateOrganizationDialog
        open={showCreateOrgDialog}
        onOpenChange={setShowCreateOrgDialog}
      />
    </>
  );
}

function ProjectRow({
  project,
  isActive,
  isAuthenticated,
  onClick,
  onOpenSettings,
  onDeleteProject,
}: {
  project: Project;
  isActive: boolean;
  isAuthenticated: boolean;
  onClick: () => void;
  onOpenSettings?: () => void;
  onDeleteProject: (projectId: string) => void;
}) {
  return (
    <div
      role="menuitem"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "group/proj flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] cursor-pointer",
        isActive ? "bg-accent" : "hover:bg-accent/60"
      )}
    >
      <ProjectIconBadge
        icon={project.icon}
        fallback={project.name.charAt(0).toUpperCase()}
        size={6}
      />
      <span className="flex-1 truncate font-medium">{project.name}</span>
      <ProjectRowMembers
        projectId={project.sharedProjectId ?? null}
        isAuthenticated={isAuthenticated}
      />
      <div className="hidden group-hover/proj:flex group-focus-within/proj:flex items-center gap-0.5 shrink-0">
        {onOpenSettings ? (
          <button
            type="button"
            aria-label={`Open ${project.name} settings`}
            title={`Open ${project.name} settings`}
            onClick={(e) => {
              e.stopPropagation();
              onOpenSettings();
            }}
            className="p-0.5 rounded text-muted-foreground/70 hover:text-foreground hover:bg-muted transition-colors"
          >
            <Settings className="size-3.5" />
          </button>
        ) : null}
        {!project.isDefault ? (
          <ProjectDeleteButton
            project={project}
            deleteState={getProjectDeleteState({ project, isAuthenticated })}
            onDeleteProject={onDeleteProject}
          />
        ) : null}
      </div>
    </div>
  );
}

function ProjectRowMembers({
  projectId,
  isAuthenticated,
}: {
  projectId: string | null;
  isAuthenticated: boolean;
}) {
  const { activeMembers } = useProjectMembers({ isAuthenticated, projectId });
  if (activeMembers.length === 0) return null;
  const visible = activeMembers.slice(0, 3);
  const overflow = activeMembers.length - visible.length;
  return (
    <div className="flex -space-x-1 shrink-0">
      {visible.map((member) => {
        const name = member.user?.name || member.email;
        return (
          <Avatar key={member._id} className="size-4" title={name}>
            <AvatarImage src={member.user?.imageUrl || undefined} alt={name} />
            <AvatarFallback className="text-[7px] bg-muted text-muted-foreground font-semibold">
              {getInitials(name)}
            </AvatarFallback>
          </Avatar>
        );
      })}
      {overflow > 0 ? (
        <div
          className="size-4 rounded-full bg-muted flex items-center justify-center text-[7px] font-semibold text-muted-foreground"
          title={`${overflow} more`}
        >
          +{overflow}
        </div>
      ) : null}
    </div>
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
              "p-0.5 rounded transition-colors",
              deleteState.canDelete
                ? "text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10"
                : "cursor-not-allowed text-muted-foreground/40"
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
      className={cn(
        "flex items-center justify-center bg-primary/10 text-primary font-semibold shrink-0",
        sizeClass,
        size === 8 ? "text-sm" : "text-[11px]"
      )}
    >
      {IconComponent ? (
        <IconComponent className={iconSize} strokeWidth={1.5} />
      ) : (
        fallback
      )}
    </div>
  );
}
