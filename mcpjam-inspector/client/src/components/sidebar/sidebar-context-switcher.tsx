import { useState, useMemo, useEffect } from "react";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import {
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
import { CreateOrganizationDialog } from "@/components/organization/CreateOrganizationDialog";
import { CreateProjectDialog } from "@/components/project/CreateProjectDialog";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";

interface SidebarContextSwitcherProps {
  activeProjectId: string;
  projects: Record<string, Project>;
  onSwitchProject: (projectId: string) => void;
  onCreateProject: (name: string, organizationId?: string) => Promise<string>;
  onDeleteProject: (projectId: string) => void;
  isLoading?: boolean;
  /** Opens one project's settings directly. See `onOpenProjectSettings`. */
  onNavigateToSettings?: (projectId: string) => void;
  isCreateDisabled?: boolean;
  createDisabledReason?: string;
  onLearnMoreExpand?: (tabId: string, sourceRect: DOMRect | null) => void;
  activeOrganizationId?: string;
  /**
   * Switches the active organization by NAVIGATING to a project inside it.
   *
   * The URL is the switch, exactly as it is for a project row: the route
   * coordinator reads the new project out of the pathname and moves the
   * organization to match. Setting hidden state instead is what made the
   * previous org rows appear to do nothing — the pathname still named a
   * project in the old organization, and the coordinator switched back to it.
   */
  onSwitchOrganization?: (organizationId: string) => void;
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

/**
 * The organization and project picker.
 *
 * Two views behind one trigger, because the two questions are asked at very
 * different rates. Opening it lands on projects every time — the frequent
 * choice owns the body — and the organization is a header row you drill into,
 * not a permanently expanded second list competing for the same space.
 *
 * Everything that changes what you are looking at happens by NAVIGATING. A
 * project row and an organization row both mint a URL and let the route
 * coordinator perform the switch; neither writes hidden state and then repairs
 * the address bar afterwards, which is the shape that made both of them racy.
 */
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
}: SidebarContextSwitcherProps) {
  const { isMobile } = useSidebar();
  const { isAuthenticated } = useConvexAuth();
  const { user, signIn } = useAuth();
  const { sortedOrganizations, canCreateOrganization } = useOrganizationQueries(
    { isAuthenticated }
  );
  const showSignInChip = !user;

  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<"projects" | "organizations">("projects");
  const [showCreateOrgDialog, setShowCreateOrgDialog] = useState(false);
  const [showCreateProjectDialog, setShowCreateProjectDialog] = useState(false);
  // Deleting a project takes everything in it. The switcher used to do that
  // on a single click of a button revealed by hover — the easiest possible
  // gesture for the least reversible action here.
  const [pendingDeleteProject, setPendingDeleteProject] =
    useState<Project | null>(null);

  // Switching orgs is rare; start every menu open on the common case (projects).
  useEffect(() => {
    setView("projects");
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
  const organizationName = activeOrg?.name ?? "No organization";

  const projectsList = Object.values(projects);
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

  // "Project", "Project 2", "Project 3" — the first name not already taken.
  // The dialog prefills it and the user is free to replace it.
  const defaultProjectName = (() => {
    const baseName = "Project";
    let name = baseName;
    let counter = 1;
    const projectNames = projectsList.map((p) => p.name.toLowerCase());
    while (projectNames.includes(name.toLowerCase())) {
      counter++;
      name = `${baseName} ${counter}`;
    }
    return name;
  })();

  // Organizations this viewer could actually create a project in. Two rules
  // are decidable from the membership list we already have:
  //   - a seat-pending org is denied every server-side query, so a project
  //     created in one could not then be opened;
  //   - a guest cannot create at all.
  // A per-organization project cap is NOT decidable here — the billing gate is
  // resolved for the active organization only — so a create into a capped
  // organization still relies on the server rejection and its toast.
  const creatableOrganizations = sortedOrganizations.filter(
    (org) =>
      org.seatPending !== true &&
      (org.myRole === undefined ||
        org.myRole === "owner" ||
        org.myRole === "admin" ||
        org.myRole === "member")
  );

  const openCreateProjectDialog = () => {
    if (isCreateDisabled) return;
    setShowCreateProjectDialog(true);
    setMenuOpen(false);
  };

  const openCreateOrgDialog = () => {
    setShowCreateOrgDialog(true);
    setMenuOpen(false);
  };

  const switchOrganization = (organizationId: string) => {
    if (organizationId !== activeOrganizationId) {
      onSwitchOrganization?.(organizationId);
    }
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
      <OrgIconBadge org={activeOrg} size={8} />
      {/* Organization first and bold, project beneath it: the org is the
          broader context, and reading them the other way round made the
          heading change every time you switched project inside one org. */}
      <div className="grid flex-1 text-left text-xs leading-tight group-data-[collapsible=icon]:hidden min-w-0">
        <span className="truncate font-semibold">{organizationName}</span>
        <span className="truncate text-xs text-muted-foreground">
          {projectName}
        </span>
      </div>
      <ChevronDown className="ml-auto size-4 group-data-[collapsible=icon]:hidden" />
    </SidebarMenuButton>
  );

  const createProjectRow =
    isCreateDisabled && createDisabledReason ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex">
            <button
              type="button"
              disabled
              aria-disabled="true"
              aria-label="Create project"
              title={createDisabledReason}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground/40 cursor-not-allowed"
            >
              <div className="flex items-center justify-center size-6 rounded bg-muted/50 shrink-0">
                <Plus className="size-3.5" />
              </div>
              <span className="flex-1 truncate text-left font-medium">
                Create project
              </span>
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{createDisabledReason}</TooltipContent>
      </Tooltip>
    ) : (
      <button
        type="button"
        aria-label="Create project"
        title="Create project"
        onClick={openCreateProjectDialog}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
      >
        <div className="flex items-center justify-center size-6 rounded bg-muted shrink-0">
          <Plus className="size-3.5" />
        </div>
        <span className="flex-1 truncate text-left font-medium">
          Create project
        </span>
      </button>
    );

  const projectsView = (
    <>
      <div className="px-1.5 pt-1.5 pb-1">
        {showSignInChip ? (
          <button
            type="button"
            data-testid="org-sign-in-button"
            onClick={() => {
              captureAppSignInReturnPath();
              signIn(permalinkSignInOptions());
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
          // Always openable for a signed-in viewer, even with one organization:
          // the list is also where "New organization" lives, and a header that
          // only sometimes responds to a click is worse than one that always
          // shows you what you have.
          <button
            type="button"
            data-testid="org-header-button"
            aria-label={`Switch organization. Current: ${organizationName}`}
            onClick={() => setView("organizations")}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent transition-colors"
          >
            <OrgIconBadge org={activeOrg} size={6} />
            <span className="flex-1 min-w-0">
              <span className="block truncate text-[13px] font-medium">
                {organizationName}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                Organization
              </span>
            </span>
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          </button>
        )}
      </div>

      {/* Inset hairline divider */}
      <div className="mx-3 h-px bg-border/70" />

      <div className="px-1.5 pt-1 pb-1.5">
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
                    ? () => {
                        setMenuOpen(false);
                        // ONE navigation, to that project's settings URL. No
                        // pre-switch: the URL is the switch, and the route
                        // coordinator performs it. The old switch-then-navigate
                        // pair is what the snap-to-Servers effect used to race.
                        onNavigateToSettings(project.id);
                      }
                    : undefined
                }
                onRequestDelete={setPendingDeleteProject}
              />
            ))
          )}
        </div>
        <div className="mt-0.5">{createProjectRow}</div>
      </div>
    </>
  );

  const organizationsView = (
    <>
      <div className="px-1.5 pt-1.5 pb-1">
        <button
          type="button"
          data-testid="org-list-back-button"
          aria-label="Back to projects"
          onClick={() => setView("projects")}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent transition-colors"
        >
          <ChevronLeft
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="flex-1 min-w-0 truncate text-[13px] font-semibold">
            Organizations
          </span>
        </button>
      </div>

      <div className="mx-3 h-px bg-border/70" />

      <div data-testid="org-switch-list" className="px-1.5 pt-1 pb-1.5">
        <div className="max-h-64 overflow-y-auto">
          {sortedOrganizations.map((org) => {
            // Paid-seat invite that hasn't linked yet: the backend denies every
            // query for this org, so the row is shown but not openable.
            const isSeatPending = org.seatPending === true;
            const isActive = org._id === activeOrganizationId;
            const row = (
              <div
                key={org._id}
                role="menuitem"
                tabIndex={isSeatPending ? -1 : 0}
                aria-disabled={isSeatPending || undefined}
                data-testid={`org-row-${org._id}`}
                onClick={() => {
                  if (isSeatPending) return;
                  switchOrganization(org._id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (isSeatPending) return;
                    switchOrganization(org._id);
                  }
                }}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px]",
                  isSeatPending
                    ? "cursor-not-allowed opacity-50"
                    : "cursor-pointer",
                  isActive
                    ? "bg-accent"
                    : !isSeatPending && "hover:bg-accent/60"
                )}
              >
                <OrgIconBadge org={org} size={5} />
                <span className="flex-1 truncate font-medium">{org.name}</span>
                {isActive ? (
                  <Check
                    aria-hidden="true"
                    data-testid={`org-active-check-${org._id}`}
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                ) : null}
              </div>
            );

            if (!isSeatPending) return row;
            return (
              <Tooltip key={org._id}>
                <TooltipTrigger asChild>{row}</TooltipTrigger>
                <TooltipContent side="right">Seat not paid yet</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        {newOrganizationRow ? (
          <div className="mt-0.5">{newOrganizationRow}</div>
        ) : null}
      </div>
    </>
  );

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            {onLearnMoreExpand ? (
              <LearnMoreHoverCard
                tabId="projects"
                onExpand={onLearnMoreExpand}
                // Both open to the right of this same trigger, so the preview
                // card would otherwise animate over the open menu.
                suppressed={menuOpen}
              >
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
              {view === "organizations" ? organizationsView : projectsView}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      <CreateOrganizationDialog
        open={showCreateOrgDialog}
        onOpenChange={setShowCreateOrgDialog}
      />
      <CreateProjectDialog
        open={showCreateProjectDialog}
        onOpenChange={setShowCreateProjectDialog}
        organizations={creatableOrganizations}
        defaultOrganizationId={activeOrganizationId}
        defaultName={defaultProjectName}
        onCreate={onCreateProject}
      />
      <AlertDialog
        open={pendingDeleteProject !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteProject(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{pendingDeleteProject?.name}
              &rdquo; and all its servers. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDeleteProject) {
                  onDeleteProject(pendingDeleteProject.id);
                }
                setPendingDeleteProject(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ProjectRow({
  project,
  isActive,
  isAuthenticated,
  onClick,
  onOpenSettings,
  onRequestDelete,
}: {
  project: Project;
  isActive: boolean;
  isAuthenticated: boolean;
  onClick: () => void;
  onOpenSettings?: () => void;
  onRequestDelete: (project: Project) => void;
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
      />
      <span className="flex-1 truncate font-medium">{project.name}</span>
      {isActive ? (
        <Check
          aria-hidden="true"
          data-testid={`project-active-check-${project.id}`}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : null}
      <ProjectRowMembers
        projectId={project.sharedProjectId ?? null}
        isAuthenticated={isAuthenticated}
      />
      {/* Keep the cluster in flow (invisible, not display:none) so revealing it
          on hover doesn't shove the member avatars sideways. */}
      <div className="invisible group-hover/proj:visible group-focus-within/proj:visible flex items-center gap-0.5 shrink-0">
        {onOpenSettings ? (
          <button
            type="button"
            aria-label={`Open ${project.name} settings`}
            title="Edit project"
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
            onRequestDelete={onRequestDelete}
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
  onRequestDelete,
}: {
  project: Project;
  deleteState: ProjectDeleteState;
  onRequestDelete: (project: Project) => void;
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
              onRequestDelete(project);
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

/**
 * An organization's tinted initial, or a neutral building for the guest /
 * no-organization case. One component so the trigger, the header row and the
 * organization list all read as the same object at three sizes.
 */
function OrgIconBadge({
  org,
  size,
}: {
  org?: { _id: string; name: string };
  size: 5 | 6 | 8;
}) {
  const sizeClass =
    size === 8
      ? "size-8 rounded-lg"
      : size === 6
        ? "size-6 rounded-md"
        : "size-5 rounded";
  const textClass =
    size === 8 ? "text-sm" : size === 6 ? "text-[11px]" : "text-[10px]";
  const iconClass = size === 8 ? "size-4" : "size-3.5";
  if (!org) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-muted text-muted-foreground shrink-0",
          sizeClass
        )}
      >
        <Building2 className={iconClass} />
      </div>
    );
  }
  const tint = getOrgTint(org._id);
  return (
    <div
      className={cn(
        "flex items-center justify-center font-semibold shrink-0",
        sizeClass,
        textClass,
        tint.bg,
        tint.fg
      )}
    >
      {org.name.charAt(0).toUpperCase()}
    </div>
  );
}

function ProjectIconBadge({
  icon,
  fallback,
}: {
  icon?: string;
  fallback: string;
}) {
  const IconComponent = icon ? resolveProjectIcon(icon) : null;
  return (
    <div className="flex size-6 items-center justify-center rounded bg-primary/10 text-[11px] font-semibold text-primary shrink-0">
      {IconComponent ? (
        <IconComponent className="h-3.5 w-3.5" strokeWidth={1.5} />
      ) : (
        fallback
      )}
    </div>
  );
}
