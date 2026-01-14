import { useState } from "react";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { getInitials } from "@/lib/utils";
import { Share2, UserPlus } from "lucide-react";
import { ShareWorkspaceDialog } from "./ShareWorkspaceDialog";
import { useWorkspaceMembers } from "@/hooks/useWorkspaces";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import { cn } from "@/lib/utils";

interface WorkspaceMembersProps {
  workspaceName: string;
  workspaceServers: Record<string, any>;
  sharedWorkspaceId?: string | null;
  onWorkspaceShared?: (sharedWorkspaceId: string) => void;
  onLeaveWorkspace?: () => void;
}

export function WorkspaceMembers({
  workspaceName,
  workspaceServers,
  sharedWorkspaceId,
  onWorkspaceShared,
  onLeaveWorkspace,
}: WorkspaceMembersProps) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const { profilePictureUrl } = useProfilePicture();
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);

  const { activeMembers, isLoading } = useWorkspaceMembers({
    isAuthenticated,
    workspaceId: sharedWorkspaceId ?? null,
  });

  if (!isAuthenticated || !user) {
    return null;
  }

  if (!sharedWorkspaceId) {
    const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ");
    const initials = getInitials(displayName);

    return (
      <div className="flex items-center gap-2">
        <div className="flex -space-x-2">
          <Avatar className="size-8 border-2 border-background">
            <AvatarImage src={profilePictureUrl} alt={displayName} />
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => setIsShareDialogOpen(true)}
        >
          <UserPlus className="size-4" />
          <span className="hidden sm:inline">Invite</span>
        </Button>
        <ShareWorkspaceDialog
          isOpen={isShareDialogOpen}
          onClose={() => setIsShareDialogOpen(false)}
          workspaceName={workspaceName}
          workspaceServers={workspaceServers}
          sharedWorkspaceId={sharedWorkspaceId}
          currentUser={user}
          onWorkspaceShared={onWorkspaceShared}
          onLeaveWorkspace={onLeaveWorkspace}
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex -space-x-2">
          <div className="size-8 rounded-full bg-muted animate-pulse" />
        </div>
      </div>
    );
  }

  const displayMembers = activeMembers.slice(0, 4);
  const remainingCount = activeMembers.length - 4;

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => setIsShareDialogOpen(true)}
        className="flex -space-x-2 hover:opacity-80 transition-opacity"
      >
        {displayMembers.map((member) => {
          const name = member.user?.name || member.email;
          const initials = getInitials(name);
          return (
            <Avatar
              key={member._id}
              className={cn(
                "size-8 border-2 border-background ring-0",
                "hover:z-10 transition-transform hover:scale-105"
              )}
            >
              <AvatarImage src={member.user?.imageUrl || undefined} alt={name} />
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
          );
        })}
        {remainingCount > 0 && (
          <div className="size-8 rounded-full border-2 border-background bg-muted flex items-center justify-center">
            <span className="text-xs font-medium text-muted-foreground">
              +{remainingCount}
            </span>
          </div>
        )}
      </button>

      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5"
        onClick={() => setIsShareDialogOpen(true)}
      >
        <Share2 className="size-4" />
        <span className="hidden sm:inline">Share</span>
      </Button>

      <ShareWorkspaceDialog
        isOpen={isShareDialogOpen}
        onClose={() => setIsShareDialogOpen(false)}
        workspaceName={workspaceName}
        workspaceServers={workspaceServers}
        sharedWorkspaceId={sharedWorkspaceId}
        currentUser={user}
        onWorkspaceShared={onWorkspaceShared}
        onLeaveWorkspace={onLeaveWorkspace}
      />
    </div>
  );
}
