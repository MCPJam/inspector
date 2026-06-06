import { useEffect, useMemo, useRef, useState } from "react";
import { useFeatureFlagEnabled, usePostHog } from "posthog-js/react";
import { detectPlatform, detectEnvironment } from "@/lib/PosthogUtils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Avatar, AvatarFallback, AvatarImage } from "@mcpjam/design-system/avatar";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import { getInitials } from "@/lib/utils";
import { ChevronDown, Clock, CreditCard, Globe, Lock } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  type ProjectMember,
  type ProjectRole,
  useProjectMutations,
  useProjectMembers,
} from "@/hooks/useProjects";
import { useConvexAuth } from "convex/react";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import { serializeServersForSharing } from "@/lib/project-serialization";
import { useOrganizationBilling } from "@/hooks/useOrganizationBilling";
import { BILLING_GATES, resolveBillingGateState } from "@/lib/billing-gates";
import { SeatProrationNote } from "@/components/billing/SeatProrationNote";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import {
  getBillingUpsellCtaLabel,
  getBillingUpsellTeaser,
} from "@/lib/billing-upsell";
import { resolveProjectIcon } from "@/components/project/ProjectEmojiPicker";
import type { Project, ProjectVisibility } from "@/state/app-types";
import type { User } from "@workos-inc/authkit-js";
import { useAppNavigate } from "@/lib/app-navigation";

interface ShareProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectName: string;
  projectServers: Record<string, any>;
  sharedProjectId?: string | null;
  organizationId?: string;
  visibility?: ProjectVisibility;
  organizationName?: string;
  currentUser: User;
  onProjectShared?: (
    sharedProjectId: string,
    sourceProjectId?: string,
  ) => void;
  availableProjects?: Record<string, Project>;
  activeProjectId?: string;
}

const INVITE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildInviteToastMessage(
  result: { kind: string },
  email: string,
): string {
  switch (result.kind) {
    case "organization_member_added":
      return `${email} added to the organization. They now have access to this project.`;
    case "organization_invite_pending":
      return `Invitation sent to ${email}. They'll get access to this project once they join the organization.`;
    case "project_access_granted":
      return `${email} has been added to the project.`;
    case "project_invite_pending":
      return `Invitation sent to ${email}. They'll get project access once they join the organization.`;
    case "already_pending":
      return `${email} already has a pending invite.`;
    case "already_has_access":
      return `${email} already has access to this project.`;
    default:
      return `${email} has been invited.`;
  }
}

function projectRoleLabel(role: ProjectRole): string {
  return role === "admin" ? "Admin" : "Editor";
}

function projectRoleDescription(role: ProjectRole): string {
  return role === "admin"
    ? "Can manage members and settings"
    : "Can edit servers";
}

function sortProjects(projects: Record<string, Project>): Project[] {
  return Object.values(projects).sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });
}

function ProjectPickerBadge({
  icon,
  projectName,
}: {
  icon?: string;
  projectName: string;
}) {
  const IconComponent = icon ? resolveProjectIcon(icon) : null;
  const fallback = projectName.charAt(0).toUpperCase() || "W";

  return (
    <div className="flex size-6 shrink-0 items-center justify-center rounded bg-primary/10 text-xs font-semibold text-primary">
      {IconComponent ? (
        <IconComponent className="h-3.5 w-3.5" strokeWidth={1.5} />
      ) : (
        fallback
      )}
    </div>
  );
}

export function ShareProjectDialog({
  isOpen,
  onClose,
  projectName,
  projectServers,
  sharedProjectId,
  organizationId,
  visibility,
  organizationName,
  currentUser,
  onProjectShared,
  availableProjects,
  activeProjectId,
}: ShareProjectDialogProps) {
  const appNavigate = useAppNavigate();
  const posthog = usePostHog();
  const [email, setEmail] = useState("");
  const [isInviting, setIsInviting] = useState(false);
  const [currentVisibility, setCurrentVisibility] =
    useState<ProjectVisibility>(visibility ?? "public");
  const [isUpdatingVisibility, setIsUpdatingVisibility] = useState(false);

  const { isAuthenticated } = useConvexAuth();
  const { profilePictureUrl } = useProfilePicture();
  const [inviteRole, setInviteRole] = useState<ProjectRole>("editor");
  const [selectedProjectId, setSelectedProjectId] = useState<
    string | null
  >(activeProjectId ?? null);
  const previousIsOpenRef = useRef(isOpen);
  const sortedAvailableProjects = useMemo(
    () => (availableProjects ? sortProjects(availableProjects) : []),
    [availableProjects],
  );
  const resolvedSelectedProjectId = useMemo(() => {
    if (!availableProjects) {
      return activeProjectId ?? null;
    }

    if (selectedProjectId && availableProjects[selectedProjectId]) {
      return selectedProjectId;
    }

    if (activeProjectId && availableProjects[activeProjectId]) {
      return activeProjectId;
    }

    return sortedAvailableProjects[0]?.id ?? null;
  }, [
    activeProjectId,
    availableProjects,
    selectedProjectId,
    sortedAvailableProjects,
  ]);
  const selectedProjectRecord =
    availableProjects && resolvedSelectedProjectId
      ? availableProjects[resolvedSelectedProjectId]
      : null;
  const selectedProject = useMemo(
    () => ({
      localProjectId:
        selectedProjectRecord?.id ?? activeProjectId ?? undefined,
      name: selectedProjectRecord?.name ?? projectName,
      servers: selectedProjectRecord?.servers ?? projectServers,
      sharedProjectId: selectedProjectRecord
        ? selectedProjectRecord.sharedProjectId ?? null
        : sharedProjectId ?? null,
      organizationId: selectedProjectRecord?.organizationId ?? organizationId,
      visibility: selectedProjectRecord?.visibility ?? visibility,
      icon: selectedProjectRecord?.icon,
    }),
    [
      activeProjectId,
      organizationId,
      selectedProjectRecord,
      sharedProjectId,
      visibility,
      projectName,
      projectServers,
    ],
  );
  const normalizedEmail = email.trim().toLowerCase();
  const emailValidationError =
    normalizedEmail && !INVITE_EMAIL_PATTERN.test(normalizedEmail)
      ? "Enter a valid email address."
      : null;
  const showProjectPicker = sortedAvailableProjects.length > 1;

  const {
    createProject,
    updateProject,
    inviteProjectMember,
    removeProjectMember,
    updateProjectMemberRole,
    updateProjectInviteRole,
  } = useProjectMutations();

  const {
    activeMembers,
    pendingMembers,
    canManageMembers: membersCanManage,
  } = useProjectMembers({
    isAuthenticated,
    projectId: selectedProject.sharedProjectId || null,
  });

  // Billing gate for member invites
  const billingUiFlag = useFeatureFlagEnabled("billing-entitlements-ui");
  const billingUiEnabled = billingUiFlag === true;
  const {
    billingStatus,
    organizationPremiumness,
    planCatalog,
    isLoadingBilling,
    isLoadingOrganizationPremiumness,
  } = useOrganizationBilling(selectedProject.organizationId ?? null);
  const memberInviteGate = resolveBillingGateState({
    billingUiEnabled,
    organizationId: selectedProject.organizationId ?? null,
    billingStatus,
    premiumness: organizationPremiumness,
    gate: BILLING_GATES.memberInvites,
    isLoading:
      billingUiEnabled &&
      (isLoadingBilling || isLoadingOrganizationPremiumness),
  });
  const memberUpsellTeaser = getBillingUpsellTeaser({
    planCatalog,
    upgradePlan: memberInviteGate.upgradePlan,
    intent: "members",
  });
  const memberUpsellCtaLabel = getBillingUpsellCtaLabel(
    memberInviteGate.upgradePlan,
  );

  useEffect(() => {
    const wasOpen = previousIsOpenRef.current;
    previousIsOpenRef.current = isOpen;

    if (!isOpen || wasOpen) {
      return;
    }

    if (availableProjects) {
      if (activeProjectId && availableProjects[activeProjectId]) {
        setSelectedProjectId(activeProjectId);
      } else {
        setSelectedProjectId(sortedAvailableProjects[0]?.id ?? null);
      }
    } else {
      setSelectedProjectId(activeProjectId ?? null);
    }
  }, [
    activeProjectId,
    availableProjects,
    isOpen,
    sortedAvailableProjects,
  ]);

  useEffect(() => {
    setCurrentVisibility(selectedProject.visibility ?? "public");
  }, [selectedProject.visibility]);

  const canManageMembers = !selectedProject.sharedProjectId
    ? true
    : membersCanManage;

  useEffect(() => {
    if (isOpen) {
      posthog.capture("share_dialog_opened", {
        project_name: selectedProject.name,
        is_already_shared: !!selectedProject.sharedProjectId,
        member_count: activeMembers.length + pendingMembers.length,
        project_visibility: currentVisibility,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    }
    // Only fire when the dialog opens, not on downstream state changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleVisibilityChange = async (newVisibility: string) => {
    const prev = currentVisibility;
    setCurrentVisibility(newVisibility as ProjectVisibility);

    if (!selectedProject.sharedProjectId) return;

    setIsUpdatingVisibility(true);
    try {
      await updateProject({
        projectId: selectedProject.sharedProjectId,
        visibility: newVisibility,
      });
      toast.success(
        `Project visibility changed to ${newVisibility === "public" ? "organization" : "private"}`,
      );
      posthog.capture("project_visibility_changed", {
        project_name: selectedProject.name,
        new_visibility: newVisibility,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    } catch {
      setCurrentVisibility(prev);
      toast.error("Failed to update project visibility");
    } finally {
      setIsUpdatingVisibility(false);
    }
  };

  const handleInvite = async () => {
    if (!normalizedEmail || emailValidationError || !canManageMembers) return;
    if (memberInviteGate.isLoading) return;
    if (memberInviteGate.isDenied) {
      toast.error(
        memberInviteGate.denialMessage ??
          "Upgrade required to add more members",
      );
      return;
    }

    setIsInviting(true);
    try {
      let currentProjectId = selectedProject.sharedProjectId;

      if (!currentProjectId) {
        const serializedServers = serializeServersForSharing(
          selectedProject.servers,
        );
        currentProjectId = await createProject({
          organizationId: selectedProject.organizationId,
          name: selectedProject.name,
          servers: serializedServers,
          visibility: currentVisibility,
        });

        if (currentProjectId) {
          if (selectedProject.localProjectId) {
            onProjectShared?.(
              currentProjectId,
              selectedProject.localProjectId,
            );
          } else {
            onProjectShared?.(currentProjectId);
          }
        }
      }

      const result = await inviteProjectMember({
        projectId: currentProjectId!,
        email: normalizedEmail,
        role: inviteRole,
      });

      toast.success(buildInviteToastMessage(result, normalizedEmail));
      setEmail("");
      posthog.capture("project_invite_sent", {
        project_name: selectedProject.name,
        is_new_share: !selectedProject.sharedProjectId,
        invite_kind: result.kind,
        project_visibility: currentVisibility,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to invite member"));
    } finally {
      setIsInviting(false);
    }
  };

  const handleRoleChange = async (
    member: ProjectMember,
    newRole: ProjectRole,
  ) => {
    if (!selectedProject.sharedProjectId) return;
    try {
      if (member.isPending) {
        await updateProjectInviteRole({
          projectId: selectedProject.sharedProjectId,
          email: member.email,
          role: newRole,
        });
      } else {
        await updateProjectMemberRole({
          projectId: selectedProject.sharedProjectId,
          userId: member.userId!,
          role: newRole,
        });
      }
      toast.success(
        `${member.user?.name || member.email} is now ${newRole === "admin" ? "an Admin" : "an Editor"}`,
      );
    } catch (error) {
      toast.error((error as Error).message || "Failed to update role");
    }
  };

  const handleRemoveMember = async (memberEmail: string) => {
    if (!selectedProject.sharedProjectId) return;

    try {
      const result = await removeProjectMember({
        projectId: selectedProject.sharedProjectId,
        email: memberEmail,
      });

      if (!result.changed) {
        toast.success("No project access to remove.");
        return;
      }

      toast.success(
        result.removed === "pending_invite"
          ? "Invite cancelled"
          : "Project access removed",
      );
      posthog.capture("project_member_removed", {
        project_name: selectedProject.name,
        removed_kind: result.removed,
        project_visibility: currentVisibility,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    } catch (error) {
      toast.error((error as Error).message || "Failed to remove member");
    }
  };

  const displayName =
    [currentUser.firstName, currentUser.lastName].filter(Boolean).join(" ") ||
    "You";
  const displayInitials = getInitials(displayName);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Share "{selectedProject.name}" Project</DialogTitle>
          <DialogDescription className="sr-only">
            Invite people and manage access for the selected project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {showProjectPicker && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Project</label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Select project"
                    className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <ProjectPickerBadge
                      icon={selectedProject.icon}
                      projectName={selectedProject.name}
                    />
                    <span className="flex-1 text-left">
                      {selectedProject.name}
                    </span>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-[--radix-dropdown-menu-trigger-width]"
                >
                  <DropdownMenuRadioGroup
                    value={resolvedSelectedProjectId ?? ""}
                    onValueChange={setSelectedProjectId}
                  >
                    {sortedAvailableProjects.map((project) => (
                      <DropdownMenuRadioItem
                        key={project.id}
                        value={project.id}
                      >
                        <div className="flex items-center gap-2">
                          <ProjectPickerBadge
                            icon={project.icon}
                            projectName={project.name}
                          />
                          <span>{project.name}</span>
                        </div>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}

          {selectedProject.sharedProjectId && !canManageMembers && (
            <p className="text-sm text-muted-foreground">
              Only project admins can invite people.
            </p>
          )}

          {canManageMembers && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Invite with email</label>
              <div className="flex gap-2">
                <div className="flex flex-1 items-center rounded-md border border-input focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                  <Input
                    type="email"
                    placeholder="Add people, emails..."
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void handleInvite()}
                    aria-invalid={emailValidationError ? true : undefined}
                    className="flex-1 border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0 gap-1 mr-1 text-muted-foreground"
                      >
                        {projectRoleLabel(inviteRole)}
                        <ChevronDown className="size-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuRadioGroup
                        value={inviteRole}
                        onValueChange={(v) => setInviteRole(v as ProjectRole)}
                      >
                        <DropdownMenuRadioItem value="editor">
                          <div>
                            <div className="font-medium">Editor</div>
                            <p className="text-xs text-muted-foreground font-normal">
                              Can edit servers
                            </p>
                          </div>
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="admin">
                          <div>
                            <div className="font-medium">Admin</div>
                            <p className="text-xs text-muted-foreground font-normal">
                              Can manage members and settings
                            </p>
                          </div>
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <Button
                  onClick={() => void handleInvite()}
                  disabled={
                    !normalizedEmail ||
                    !!emailValidationError ||
                    isInviting ||
                    memberInviteGate.isLoading ||
                    memberInviteGate.isDenied
                  }
                >
                  {isInviting ? "..." : "Invite"}
                </Button>
              </div>

              {billingStatus?.plan &&
              planCatalog?.plans[billingStatus.plan]?.billingModel ===
                "per_seat" ? (
                <SeatProrationNote lead="Inviting someone new adds a seat." />
              ) : null}

              {emailValidationError ? (
                <p className="text-sm text-destructive">
                  {emailValidationError}
                </p>
              ) : null}

              {memberInviteGate.isDenied && (
                <Alert
                  className="border-primary/20 bg-primary/[0.04]"
                  data-testid="member-limit-upsell"
                >
                  <CreditCard className="size-4 text-primary" />
                  <AlertTitle>Need more members?</AlertTitle>
                  <AlertDescription className="gap-2">
                    {memberInviteGate.denialMessage ? (
                      <p>{memberInviteGate.denialMessage}</p>
                    ) : null}
                    {memberUpsellTeaser ? (
                      <p className="text-foreground/80">{memberUpsellTeaser}</p>
                    ) : null}
                    {billingStatus?.canManageBilling ? (
                      <Button
                        type="button"
                        size="sm"
                        className="mt-1"
                        onClick={() => {
                          if (selectedProject.organizationId) {
                            appNavigate(
                              `/organizations/${selectedProject.organizationId}/billing`,
                            );
                            onClose();
                          }
                        }}
                      >
                        {memberUpsellCtaLabel}
                      </Button>
                    ) : (
                      <p className="font-medium text-foreground/80">
                        Ask an organization owner to review billing options.
                      </p>
                    )}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          {/* Access settings */}
          {canManageMembers ? (
            <div className="space-y-2">
              <label className="text-sm font-medium">Access settings</label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
                    disabled={isUpdatingVisibility}
                  >
                    {currentVisibility === "public" ? (
                      <Globe className="size-4 shrink-0" />
                    ) : (
                      <Lock className="size-4 shrink-0" />
                    )}
                    <span className="flex-1 text-left">
                      {currentVisibility === "public"
                        ? organizationName || "Organization"
                        : "Private to members"}
                    </span>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-[--radix-dropdown-menu-trigger-width]"
                >
                  <DropdownMenuRadioGroup
                    value={currentVisibility}
                    onValueChange={handleVisibilityChange}
                  >
                    <DropdownMenuRadioItem
                      value="public"
                      className="items-start"
                    >
                      <div>
                        <div className="font-medium flex items-center gap-2">
                          <Globe className="size-4" />{" "}
                          {organizationName || "Organization"}
                        </div>
                        <p className="text-xs text-muted-foreground font-normal">
                          Everyone in your organization can find and access this
                          project.
                        </p>
                      </div>
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem
                      value="private"
                      className="items-start"
                    >
                      <div>
                        <div className="font-medium flex items-center gap-2">
                          <Lock className="size-4" /> Private to members
                        </div>
                        <p className="text-xs text-muted-foreground font-normal">
                          Only invited members can find and access this
                          project.
                        </p>
                      </div>
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-sm font-medium">Access settings</label>
              <div className="flex items-center gap-2 px-3 py-2 text-sm rounded-md border border-input bg-muted/50">
                {currentVisibility === "public" ? (
                  <Globe className="size-4 shrink-0" />
                ) : (
                  <Lock className="size-4 shrink-0" />
                )}
                <span>
                  {currentVisibility === "public"
                    ? organizationName || "Organization"
                    : "Private to members"}
                </span>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Has access</label>
            <div className="space-y-1 max-h-[300px] overflow-y-auto">
              {!selectedProject.sharedProjectId && (
                <div className="flex items-center gap-3 p-2 rounded-md">
                  <Avatar className="size-9">
                    <AvatarImage src={profilePictureUrl} alt={displayName} />
                    <AvatarFallback className="text-sm">
                      {displayInitials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium truncate">
                        {displayName}
                      </p>
                      <span className="text-xs text-muted-foreground">
                        (you)
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {currentUser.email}
                    </p>
                  </div>
                </div>
              )}

              {activeMembers.map((member) => {
                const name = member.user?.name || member.email;
                const memberEmail = member.email;
                const initials = getInitials(name);
                const isSelf =
                  memberEmail.toLowerCase() ===
                  currentUser.email?.toLowerCase();

                return (
                  <div
                    key={member._id}
                    className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50"
                  >
                    <Avatar className="size-9">
                      <AvatarImage
                        src={member.user?.imageUrl || undefined}
                        alt={name}
                      />
                      <AvatarFallback className="text-sm">
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium truncate">{name}</p>
                        {isSelf && (
                          <span className="text-xs text-muted-foreground">
                            (you)
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {memberEmail}
                      </p>
                    </div>
                    {member.canChangeRole ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 gap-1 text-sm"
                          >
                            {projectRoleLabel(member.projectRole)}
                            <ChevronDown className="size-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuRadioGroup
                            value={member.projectRole}
                            onValueChange={(v) =>
                              void handleRoleChange(member, v as ProjectRole)
                            }
                          >
                            <DropdownMenuRadioItem value="editor">
                              <div>
                                <div className="font-medium">Editor</div>
                                <p className="text-xs text-muted-foreground font-normal">
                                  {projectRoleDescription("editor")}
                                </p>
                              </div>
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="admin">
                              <div>
                                <div className="font-medium">Admin</div>
                                <p className="text-xs text-muted-foreground font-normal">
                                  {projectRoleDescription("admin")}
                                </p>
                              </div>
                            </DropdownMenuRadioItem>
                          </DropdownMenuRadioGroup>
                          {member.canRemove && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() =>
                                  void handleRemoveMember(memberEmail)
                                }
                              >
                                Remove from project
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <span className="text-sm text-muted-foreground shrink-0">
                        {projectRoleLabel(member.projectRole)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {pendingMembers.length > 0 && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Invited</label>
              <div className="space-y-1 max-h-[220px] overflow-y-auto">
                {pendingMembers.map((member) => (
                  <div
                    key={member._id}
                    className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50"
                  >
                    <div className="size-9 rounded-full bg-muted flex items-center justify-center">
                      <Clock className="size-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {member.email}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Invited to the organization and project
                      </p>
                    </div>
                    {member.canChangeRole ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 gap-1 text-sm"
                          >
                            {projectRoleLabel(member.projectRole)}
                            <ChevronDown className="size-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuRadioGroup
                            value={member.projectRole}
                            onValueChange={(v) =>
                              void handleRoleChange(member, v as ProjectRole)
                            }
                          >
                            <DropdownMenuRadioItem value="editor">
                              <div>
                                <div className="font-medium">Editor</div>
                                <p className="text-xs text-muted-foreground font-normal">
                                  {projectRoleDescription("editor")}
                                </p>
                              </div>
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="admin">
                              <div>
                                <div className="font-medium">Admin</div>
                                <p className="text-xs text-muted-foreground font-normal">
                                  {projectRoleDescription("admin")}
                                </p>
                              </div>
                            </DropdownMenuRadioItem>
                          </DropdownMenuRadioGroup>
                          {member.canRemove && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() =>
                                  void handleRemoveMember(member.email)
                                }
                              >
                                Cancel invite
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <span className="text-sm text-muted-foreground shrink-0">
                        {projectRoleLabel(member.projectRole)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
