import { useEffect, useState } from "react";
import { usePostHog } from "posthog-js/react";
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
import { getInitials } from "@/lib/utils";
import { Building2, Clock, X } from "lucide-react";
import { toast } from "sonner";
import {
  type WorkspaceMember,
  type WorkspaceMembershipRole,
  useWorkspaceMutations,
  useWorkspaceMembers,
} from "@/hooks/useWorkspaces";
import { useConvexAuth } from "convex/react";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import { serializeServersForSharing } from "@/lib/workspace-serialization";
import type { WorkspaceVisibility } from "@/state/app-types";
import type { User } from "@workos-inc/authkit-js";

interface ShareWorkspaceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceName: string;
  workspaceServers: Record<string, any>;
  sharedWorkspaceId?: string | null;
  organizationId?: string;
  visibility?: WorkspaceVisibility;
  currentUser: User;
  onWorkspaceShared?: (sharedWorkspaceId: string) => void;
  onLeaveWorkspace?: () => void;
}

function resolveWorkspaceRole(
  member: Pick<WorkspaceMember, "role" | "isOwner">,
): WorkspaceMembershipRole {
  if (member.role) return member.role;
  return member.isOwner ? "owner" : "member";
}

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

function getMemberAccessDescription(
  member: WorkspaceMember,
  visibility: WorkspaceVisibility,
): string | null {
  if (visibility === "public") {
    if (member.role === "owner" || member.role === "admin" || member.role === "guest") {
      return `Organization ${member.role}`;
    }
    return null;
  }

  if (member.accessSource === "organization") {
    return member.role === "owner" || member.role === "admin"
      ? `Access via organization ${member.role}`
      : "Access via organization";
  }

  if (member.accessSource === "workspace") {
    return "Explicit workspace access";
  }

  return null;
}

export function ShareWorkspaceDialog({
  isOpen,
  onClose,
  workspaceName,
  workspaceServers,
  sharedWorkspaceId,
  organizationId,
  visibility,
  currentUser,
  onWorkspaceShared,
}: ShareWorkspaceDialogProps) {
  const posthog = usePostHog();
  const [email, setEmail] = useState("");
  const [isInviting, setIsInviting] = useState(false);

  const { isAuthenticated } = useConvexAuth();
  const { profilePictureUrl } = useProfilePicture();
  const {
    createWorkspace,
    inviteWorkspaceMember,
    removeWorkspaceMember,
  } = useWorkspaceMutations();

  const { activeMembers, pendingMembers } = useWorkspaceMembers({
    isAuthenticated,
    workspaceId: sharedWorkspaceId || null,
  });

  const workspaceVisibility: WorkspaceVisibility = visibility ?? "public";
  const isPublicWorkspace = workspaceVisibility === "public";

  const currentMember = activeMembers.find(
    (member) => member.email.toLowerCase() === currentUser.email?.toLowerCase(),
  );
  const currentRole: WorkspaceMembershipRole | null = !sharedWorkspaceId
    ? "owner"
    : currentMember
      ? resolveWorkspaceRole(currentMember)
      : null;
  const canManageMembers = !sharedWorkspaceId
    ? true
    : currentRole === "owner" || currentRole === "admin";

  useEffect(() => {
    if (isOpen) {
      posthog.capture("share_dialog_opened", {
        workspace_name: workspaceName,
        is_already_shared: !!sharedWorkspaceId,
        member_count: activeMembers.length + pendingMembers.length,
        workspace_visibility: workspaceVisibility,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    }
  }, [
    isOpen,
    workspaceName,
    sharedWorkspaceId,
    activeMembers.length,
    pendingMembers.length,
    workspaceVisibility,
    posthog,
  ]);

  const handleInvite = async () => {
    if (!email.trim() || !canManageMembers) return;

    setIsInviting(true);
    try {
      let currentWorkspaceId = sharedWorkspaceId;

      if (!currentWorkspaceId) {
        const serializedServers = serializeServersForSharing(workspaceServers);
        currentWorkspaceId = await createWorkspace({
          name: workspaceName,
          servers: serializedServers,
        });

        if (currentWorkspaceId) {
          onWorkspaceShared?.(currentWorkspaceId);
        }
      }

      const result = await inviteWorkspaceMember({
        workspaceId: currentWorkspaceId!,
        email: email.trim(),
      });

      toast.success(buildInviteToastMessage(result, email.trim()));
      setEmail("");
      posthog.capture("workspace_invite_sent", {
        workspace_name: workspaceName,
        is_new_share: !sharedWorkspaceId,
        invite_kind: result.kind,
        workspace_visibility: workspaceVisibility,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    } catch (error) {
      toast.error((error as Error).message || "Failed to invite member");
    } finally {
      setIsInviting(false);
    }
  };

  const handleRemoveMember = async (memberEmail: string) => {
    if (!sharedWorkspaceId) return;

    try {
      const result = await removeWorkspaceMember({
        workspaceId: sharedWorkspaceId,
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
        workspace_name: workspaceName,
        removed_kind: result.removed,
        workspace_visibility: workspaceVisibility,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    } catch (error) {
      toast.error((error as Error).message || "Failed to remove member");
    }
  };

  const openOrganizationMembers = () => {
    if (!organizationId) return;
    window.location.hash = `organizations/${organizationId}`;
    onClose();
  };

  const displayName =
    [currentUser.firstName, currentUser.lastName].filter(Boolean).join(" ") ||
    "You";
  const displayInitials = getInitials(displayName);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Share "{workspaceName}" Workspace</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          <div className="space-y-3">
            <DialogDescription className="text-sm text-muted-foreground">
              {isPublicWorkspace
                ? "This workspace is available to everyone in this organization. Invite people to the organization to give them access."
                : "Only invited organization members can access this workspace. If someone is not in the organization yet, they'll be invited first and granted workspace access after signup."}
            </DialogDescription>

            {isPublicWorkspace && organizationId && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openOrganizationMembers}
              >
                <Building2 className="size-4 mr-2" />
                Manage organization members
              </Button>
            )}

            {sharedWorkspaceId && !canManageMembers && (
              <p className="text-sm text-muted-foreground">
                {isPublicWorkspace
                  ? "Organization admins can invite people here because public workspace access follows organization membership."
                  : "Organization admins can invite people and manage private workspace access."}
              </p>
            )}
          </div>

          {canManageMembers && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Invite with email</label>
              <div className="flex gap-2">
                <Input
                  placeholder="Enter email address"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void handleInvite()}
                  className="flex-1"
                />
                <Button
                  onClick={() => void handleInvite()}
                  disabled={!email.trim() || isInviting}
                >
                  {isInviting
                    ? "..."
                    : isPublicWorkspace
                      ? "Invite to organization"
                      : "Invite to workspace"}
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Has access</label>
            <div className="space-y-1 max-h-[300px] overflow-y-auto">
              {!sharedWorkspaceId && (
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
                const memberDescription = getMemberAccessDescription(
                  member,
                  workspaceVisibility,
                );

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
                      {memberDescription && (
                        <p className="text-xs text-muted-foreground truncate">
                          {memberDescription}
                        </p>
                      )}
                    </div>
                    {member.canRemove && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                        aria-label={`Remove ${memberEmail} from workspace`}
                        onClick={() => void handleRemoveMember(memberEmail)}
                      >
                        <X className="size-4" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {!isPublicWorkspace && pendingMembers.length > 0 && (
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
                    {member.canRemove && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                        aria-label={`Cancel invite for ${member.email}`}
                        onClick={() => void handleRemoveMember(member.email)}
                      >
                        <X className="size-4" />
                      </Button>
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
