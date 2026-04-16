import { useEffect, useMemo, useRef, useState } from "react";
import { useFeatureFlagEnabled, usePostHog } from "posthog-js/react";
import { detectPlatform, detectEnvironment } from "@/lib/PosthogUtils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
} from "@/components/ui/dropdown-menu";
import {
  type WorkspaceMember,
  type WorkspaceRole,
  useWorkspaceMutations,
  useWorkspaceMembers,
} from "@/hooks/useWorkspaces";
import { useConvexAuth } from "convex/react";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import { serializeServersForSharing } from "@/lib/workspace-serialization";
import { useOrganizationBilling } from "@/hooks/useOrganizationBilling";
import { BILLING_GATES, resolveBillingGateState } from "@/lib/billing-gates";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import {
  getBillingUpsellCtaLabel,
  getBillingUpsellTeaser,
} from "@/lib/billing-upsell";
import { resolveWorkspaceIcon } from "@/components/workspace/WorkspaceEmojiPicker";
import type { Workspace, WorkspaceVisibility } from "@/state/app-types";
import type { User } from "@workos-inc/authkit-js";

interface ShareWorkspaceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceName: string;
  workspaceServers: Record<string, any>;
  sharedWorkspaceId?: string | null;
  organizationId?: string;
  visibility?: WorkspaceVisibility;
  organizationName?: string;
  currentUser: User;
  onWorkspaceShared?: (
    sharedWorkspaceId: string,
    sourceWorkspaceId?: string,
  ) => void;
  availableWorkspaces?: Record<string, Workspace>;
  activeWorkspaceId?: string;
}

const INVITE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildInviteToastMessage(
  result: { kind: string },
  email: string,
): string {
  switch (result.kind) {
    case "organization_member_added":
      return `${email} added to the organization. They now have access to this workspace.`;
    case "organization_invite_pending":
      return `Invitation sent to ${email}. They'll get access to this workspace once they join the organization.`;
    case "workspace_access_granted":
      return `${email} has been added to the workspace.`;
    case "workspace_invite_pending":
      return `Invitation sent to ${email}. They'll get workspace access once they join the organization.`;
    case "already_pending":
      return `${email} already has a pending invite.`;
    case "already_has_access":
      return `${email} already has access to this workspace.`;
    default:
      return `${email} has been invited.`;
  }
}

function workspaceRoleLabel(role: WorkspaceRole): string {
  return role === "admin" ? "Admin" : "Editor";
}

function workspaceRoleDescription(role: WorkspaceRole): string {
  return role === "admin"
    ? "Can manage members and settings"
    : "Can edit servers";
}

function sortWorkspaces(workspaces: Record<string, Workspace>): Workspace[] {
  return Object.values(workspaces).sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });
}

function WorkspacePickerBadge({
  icon,
  workspaceName,
}: {
  icon?: string;
  workspaceName: string;
}) {
  const IconComponent = icon ? resolveWorkspaceIcon(icon) : null;
  const fallback = workspaceName.charAt(0).toUpperCase() || "W";

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

export function ShareWorkspaceDialog({
  isOpen,
  onClose,
  workspaceName,
  workspaceServers,
  sharedWorkspaceId,
  organizationId,
  visibility,
  organizationName,
  currentUser,
  onWorkspaceShared,
  availableWorkspaces,
  activeWorkspaceId,
}: ShareWorkspaceDialogProps) {
  const posthog = usePostHog();
  const [email, setEmail] = useState("");
  const [isInviting, setIsInviting] = useState(false);
  const [currentVisibility, setCurrentVisibility] =
    useState<WorkspaceVisibility>(visibility ?? "public");
  const [isUpdatingVisibility, setIsUpdatingVisibility] = useState(false);

  const { isAuthenticated } = useConvexAuth();
  const { profilePictureUrl } = useProfilePicture();
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("editor");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<
    string | null
  >(activeWorkspaceId ?? null);
  const previousIsOpenRef = useRef(isOpen);
  const sortedAvailableWorkspaces = useMemo(
    () => (availableWorkspaces ? sortWorkspaces(availableWorkspaces) : []),
    [availableWorkspaces],
  );
  const resolvedSelectedWorkspaceId = useMemo(() => {
    if (!availableWorkspaces) {
      return activeWorkspaceId ?? null;
    }

    if (selectedWorkspaceId && availableWorkspaces[selectedWorkspaceId]) {
      return selectedWorkspaceId;
    }

    if (activeWorkspaceId && availableWorkspaces[activeWorkspaceId]) {
      return activeWorkspaceId;
    }

    return sortedAvailableWorkspaces[0]?.id ?? null;
  }, [
    activeWorkspaceId,
    availableWorkspaces,
    selectedWorkspaceId,
    sortedAvailableWorkspaces,
  ]);
  const selectedWorkspaceRecord =
    availableWorkspaces && resolvedSelectedWorkspaceId
      ? availableWorkspaces[resolvedSelectedWorkspaceId]
      : null;
  const selectedWorkspace = useMemo(
    () => ({
      localWorkspaceId:
        selectedWorkspaceRecord?.id ?? activeWorkspaceId ?? undefined,
      name: selectedWorkspaceRecord?.name ?? workspaceName,
      servers: selectedWorkspaceRecord?.servers ?? workspaceServers,
      sharedWorkspaceId: selectedWorkspaceRecord
        ? selectedWorkspaceRecord.sharedWorkspaceId ?? null
        : sharedWorkspaceId ?? null,
      organizationId: selectedWorkspaceRecord?.organizationId ?? organizationId,
      visibility: selectedWorkspaceRecord?.visibility ?? visibility,
      icon: selectedWorkspaceRecord?.icon,
    }),
    [
      activeWorkspaceId,
      organizationId,
      selectedWorkspaceRecord,
      sharedWorkspaceId,
      visibility,
      workspaceName,
      workspaceServers,
    ],
  );
  const normalizedEmail = email.trim().toLowerCase();
  const emailValidationError =
    normalizedEmail && !INVITE_EMAIL_PATTERN.test(normalizedEmail)
      ? "Enter a valid email address."
      : null;
  const showWorkspacePicker = sortedAvailableWorkspaces.length > 1;

  const {
    createWorkspace,
    updateWorkspace,
    inviteWorkspaceMember,
    removeWorkspaceMember,
    updateWorkspaceMemberRole,
    updateWorkspaceInviteRole,
  } = useWorkspaceMutations();

  const {
    activeMembers,
    pendingMembers,
    canManageMembers: membersCanManage,
  } = useWorkspaceMembers({
    isAuthenticated,
    workspaceId: selectedWorkspace.sharedWorkspaceId || null,
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
  } = useOrganizationBilling(selectedWorkspace.organizationId ?? null);
  const memberInviteGate = resolveBillingGateState({
    billingUiEnabled,
    organizationId: selectedWorkspace.organizationId ?? null,
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

    if (availableWorkspaces) {
      if (activeWorkspaceId && availableWorkspaces[activeWorkspaceId]) {
        setSelectedWorkspaceId(activeWorkspaceId);
      } else {
        setSelectedWorkspaceId(sortedAvailableWorkspaces[0]?.id ?? null);
      }
    } else {
      setSelectedWorkspaceId(activeWorkspaceId ?? null);
    }
  }, [
    activeWorkspaceId,
    availableWorkspaces,
    isOpen,
    sortedAvailableWorkspaces,
  ]);

  useEffect(() => {
    setCurrentVisibility(selectedWorkspace.visibility ?? "public");
  }, [selectedWorkspace.visibility]);

  const canManageMembers = !selectedWorkspace.sharedWorkspaceId
    ? true
    : membersCanManage;

  useEffect(() => {
    if (isOpen) {
      posthog.capture("share_dialog_opened", {
        workspace_name: selectedWorkspace.name,
        is_already_shared: !!selectedWorkspace.sharedWorkspaceId,
        member_count: activeMembers.length + pendingMembers.length,
        workspace_visibility: currentVisibility,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    }
    // Only fire when the dialog opens, not on downstream state changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleVisibilityChange = async (newVisibility: string) => {
    const prev = currentVisibility;
    setCurrentVisibility(newVisibility as WorkspaceVisibility);

    if (!selectedWorkspace.sharedWorkspaceId) return;

    setIsUpdatingVisibility(true);
    try {
      await updateWorkspace({
        workspaceId: selectedWorkspace.sharedWorkspaceId,
        visibility: newVisibility,
      });
      toast.success(
        `Workspace visibility changed to ${newVisibility === "public" ? "organization" : "private"}`,
      );
      posthog.capture("workspace_visibility_changed", {
        workspace_name: selectedWorkspace.name,
        new_visibility: newVisibility,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    } catch {
      setCurrentVisibility(prev);
      toast.error("Failed to update workspace visibility");
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
      let currentWorkspaceId = selectedWorkspace.sharedWorkspaceId;

      if (!currentWorkspaceId) {
        const serializedServers = serializeServersForSharing(
          selectedWorkspace.servers,
        );
        currentWorkspaceId = await createWorkspace({
          organizationId: selectedWorkspace.organizationId,
          name: selectedWorkspace.name,
          servers: serializedServers,
          visibility: currentVisibility,
        });

        if (currentWorkspaceId) {
          if (selectedWorkspace.localWorkspaceId) {
            onWorkspaceShared?.(
              currentWorkspaceId,
              selectedWorkspace.localWorkspaceId,
            );
          } else {
            onWorkspaceShared?.(currentWorkspaceId);
          }
        }
      }

      const result = await inviteWorkspaceMember({
        workspaceId: currentWorkspaceId!,
        email: normalizedEmail,
        role: inviteRole,
      });

      toast.success(buildInviteToastMessage(result, normalizedEmail));
      setEmail("");
      posthog.capture("workspace_invite_sent", {
        workspace_name: selectedWorkspace.name,
        is_new_share: !selectedWorkspace.sharedWorkspaceId,
        invite_kind: result.kind,
        workspace_visibility: currentVisibility,
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
    member: WorkspaceMember,
    newRole: WorkspaceRole,
  ) => {
    if (!selectedWorkspace.sharedWorkspaceId) return;
    try {
      if (member.isPending) {
        await updateWorkspaceInviteRole({
          workspaceId: selectedWorkspace.sharedWorkspaceId,
          email: member.email,
          role: newRole,
        });
      } else {
        await updateWorkspaceMemberRole({
          workspaceId: selectedWorkspace.sharedWorkspaceId,
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
    if (!selectedWorkspace.sharedWorkspaceId) return;

    try {
      const result = await removeWorkspaceMember({
        workspaceId: selectedWorkspace.sharedWorkspaceId,
        email: memberEmail,
      });

      if (!result.changed) {
        toast.success("No workspace access to remove.");
        return;
      }

      toast.success(
        result.removed === "pending_invite"
          ? "Invite cancelled"
          : "Workspace access removed",
      );
      posthog.capture("workspace_member_removed", {
        workspace_name: selectedWorkspace.name,
        removed_kind: result.removed,
        workspace_visibility: currentVisibility,
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
          <DialogTitle>Share "{selectedWorkspace.name}" Workspace</DialogTitle>
          <DialogDescription className="sr-only">
            Invite people and manage access for the selected workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {showWorkspacePicker && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Workspace</label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Select workspace"
                    className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <WorkspacePickerBadge
                      icon={selectedWorkspace.icon}
                      workspaceName={selectedWorkspace.name}
                    />
                    <span className="flex-1 text-left">
                      {selectedWorkspace.name}
                    </span>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-[--radix-dropdown-menu-trigger-width]"
                >
                  <DropdownMenuRadioGroup
                    value={resolvedSelectedWorkspaceId ?? ""}
                    onValueChange={setSelectedWorkspaceId}
                  >
                    {sortedAvailableWorkspaces.map((workspace) => (
                      <DropdownMenuRadioItem
                        key={workspace.id}
                        value={workspace.id}
                      >
                        <div className="flex items-center gap-2">
                          <WorkspacePickerBadge
                            icon={workspace.icon}
                            workspaceName={workspace.name}
                          />
                          <span>{workspace.name}</span>
                        </div>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}

          {selectedWorkspace.sharedWorkspaceId && !canManageMembers && (
            <p className="text-sm text-muted-foreground">
              Only workspace admins can invite people.
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
                        {workspaceRoleLabel(inviteRole)}
                        <ChevronDown className="size-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuRadioGroup
                        value={inviteRole}
                        onValueChange={(v) => setInviteRole(v as WorkspaceRole)}
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
                          if (selectedWorkspace.organizationId) {
                            window.location.hash = `organizations/${selectedWorkspace.organizationId}/billing`;
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
                          workspace.
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
                          workspace.
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
              {!selectedWorkspace.sharedWorkspaceId && (
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
                            {workspaceRoleLabel(member.workspaceRole)}
                            <ChevronDown className="size-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuRadioGroup
                            value={member.workspaceRole}
                            onValueChange={(v) =>
                              void handleRoleChange(member, v as WorkspaceRole)
                            }
                          >
                            <DropdownMenuRadioItem value="editor">
                              <div>
                                <div className="font-medium">Editor</div>
                                <p className="text-xs text-muted-foreground font-normal">
                                  {workspaceRoleDescription("editor")}
                                </p>
                              </div>
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="admin">
                              <div>
                                <div className="font-medium">Admin</div>
                                <p className="text-xs text-muted-foreground font-normal">
                                  {workspaceRoleDescription("admin")}
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
                                Remove from workspace
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <span className="text-sm text-muted-foreground shrink-0">
                        {workspaceRoleLabel(member.workspaceRole)}
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
                        Invited to the organization and workspace
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
                            {workspaceRoleLabel(member.workspaceRole)}
                            <ChevronDown className="size-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuRadioGroup
                            value={member.workspaceRole}
                            onValueChange={(v) =>
                              void handleRoleChange(member, v as WorkspaceRole)
                            }
                          >
                            <DropdownMenuRadioItem value="editor">
                              <div>
                                <div className="font-medium">Editor</div>
                                <p className="text-xs text-muted-foreground font-normal">
                                  {workspaceRoleDescription("editor")}
                                </p>
                              </div>
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="admin">
                              <div>
                                <div className="font-medium">Admin</div>
                                <p className="text-xs text-muted-foreground font-normal">
                                  {workspaceRoleDescription("admin")}
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
                        {workspaceRoleLabel(member.workspaceRole)}
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
