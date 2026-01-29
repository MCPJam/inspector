import { useState, useEffect } from "react";
import posthog from "posthog-js";
import { detectPlatform, detectEnvironment } from "@/lib/PosthogUtils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";
import { Clock, X, LogOut } from "lucide-react";
import { toast } from "sonner";
import {
  useWorkspaceMutations,
  useWorkspaceMembers,
} from "@/hooks/useWorkspaces";
import { useConvexAuth } from "convex/react";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import { serializeServersForSharing } from "@/lib/workspace-serialization";

interface CurrentUser {
  email?: string;
  firstName?: string;
  lastName?: string;
}

interface ShareWorkspaceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceName: string;
  workspaceServers: Record<string, any>;
  sharedWorkspaceId?: string | null;
  currentUser: CurrentUser;
  onWorkspaceShared?: (sharedWorkspaceId: string) => void;
  onLeaveWorkspace?: () => void;
}

export function ShareWorkspaceDialog({
  isOpen,
  onClose,
  workspaceName,
  workspaceServers,
  sharedWorkspaceId,
  currentUser,
  onWorkspaceShared,
  onLeaveWorkspace,
}: ShareWorkspaceDialogProps) {
  const [email, setEmail] = useState("");
  const [isInviting, setIsInviting] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);

  const { isAuthenticated } = useConvexAuth();
  const { profilePictureUrl } = useProfilePicture();
  const { createWorkspace, addMember, removeMember } = useWorkspaceMutations();

  const { activeMembers, pendingMembers } = useWorkspaceMembers({
    isAuthenticated,
    workspaceId: sharedWorkspaceId || null,
  });

  const isOwner =
    !sharedWorkspaceId ||
    activeMembers.some(
      (m) =>
        m.email.toLowerCase() === currentUser.email?.toLowerCase() && m.isOwner,
    );

  useEffect(() => {
    if (isOpen) {
      posthog.capture("share_dialog_opened", {
        workspace_name: workspaceName,
        is_already_shared: !!sharedWorkspaceId,
        member_count: activeMembers.length + pendingMembers.length,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    }
  }, [isOpen]);

  const handleInvite = async () => {
    if (!email.trim()) return;

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

      const result = await addMember({
        workspaceId: currentWorkspaceId!,
        email: email.trim(),
      });

      if (result.isPending) {
        toast.success(
          `Invitation sent to ${email}. They'll get access once they sign up.`,
        );
      } else {
        toast.success(`${email} has been added to the workspace.`);
      }
      setEmail("");
      posthog.capture("workspace_invite_sent", {
        workspace_name: workspaceName,
        is_new_share: !sharedWorkspaceId,
        is_pending: result.isPending,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    } catch (error) {
      toast.error((error as Error).message || "Failed to add member");
    } finally {
      setIsInviting(false);
    }
  };

  const handleRemoveMember = async (memberEmail: string) => {
    if (!sharedWorkspaceId) return;
    try {
      await removeMember({
        workspaceId: sharedWorkspaceId,
        email: memberEmail,
      });
      toast.success("Member removed");
      posthog.capture("workspace_member_removed", {
        workspace_name: workspaceName,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    } catch (error) {
      toast.error((error as Error).message || "Failed to remove member");
    }
  };

  const handleLeaveWorkspace = async () => {
    if (!sharedWorkspaceId || !currentUser.email) return;
    setIsLeaving(true);
    try {
      await removeMember({
        workspaceId: sharedWorkspaceId,
        email: currentUser.email,
      });
      toast.success("You have left the workspace");
      posthog.capture("workspace_left", {
        workspace_name: workspaceName,
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
      onClose();
      onLeaveWorkspace?.();
    } catch (error) {
      toast.error((error as Error).message || "Failed to leave workspace");
    } finally {
      setIsLeaving(false);
    }
  };

  const displayName =
    [currentUser.firstName, currentUser.lastName].filter(Boolean).join(" ") ||
    "You";
  const displayInitials = getInitials(displayName);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Share "{workspaceName}"</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium">Invite with email</label>
            <div className="flex gap-2">
              <Input
                placeholder="Enter email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleInvite()}
                className="flex-1"
              />
              <Button
                onClick={handleInvite}
                disabled={!email.trim() || isInviting}
              >
                {isInviting ? "..." : "Invite"}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              {sharedWorkspaceId
                ? "People with access"
                : "Only you have access"}
            </label>
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
                const canRemove = isOwner && !isSelf;

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
                    {canRemove && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemoveMember(memberEmail)}
                      >
                        <X className="size-4" />
                      </Button>
                    )}
                  </div>
                );
              })}

              {pendingMembers.length > 0 && (
                <>
                  <div className="pt-2 pb-1">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Pending (awaiting signup)
                    </p>
                  </div>
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
                          Invited - waiting for signup
                        </p>
                      </div>
                      {isOwner && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => handleRemoveMember(member.email)}
                        >
                          <X className="size-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Show leave button for non-owners of shared workspaces */}
          {sharedWorkspaceId && !isOwner && (
            <Button
              variant="outline"
              className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={handleLeaveWorkspace}
              disabled={isLeaving}
            >
              <LogOut className="size-4 mr-2" />
              {isLeaving ? "Leaving..." : "Leave workspace"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
