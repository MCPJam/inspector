import { useState } from "react";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";
import { Share2 } from "lucide-react";
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
    const displayName = [user.firstName, user.lastName]
      .filter(Boolean)
      .join(" ");
    const initials = getInitials(displayName);

    return (
      <div className="flex items-center">
        <button
          onClick={() => setIsShareDialogOpen(true)}
          className="flex -space-x-2 hover:opacity-80 transition-opacity"
        >
          <Avatar className="size-8 border-2 border-background">
            <AvatarImage src={profilePictureUrl} alt={displayName} />
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
          <div className="size-8 rounded-full border-2 border-background bg-muted flex items-center justify-center hover:bg-accent transition-colors">
            <Share2 className="size-3.5 text-muted-foreground" />
          </div>
        </button>
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
    <div className="flex items-center">
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
                "hover:z-10 transition-transform hover:scale-105",
              )}
            >
              <AvatarImage
                src={member.user?.imageUrl || undefined}
                alt={name}
              />
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
          );
        })}
        <div className="size-8 rounded-full border-2 border-background bg-muted flex items-center justify-center hover:bg-accent transition-colors relative">
          {remainingCount > 0 ? (
            <>
              <Share2 className="size-3.5 text-muted-foreground" />
              <span className="absolute -top-1 -right-1 size-4 rounded-full bg-primary text-[10px] font-medium text-primary-foreground flex items-center justify-center">
                {remainingCount > 9 ? "9+" : `+${remainingCount}`}
              </span>
            </>
          ) : (
            <Share2 className="size-3.5 text-muted-foreground" />
          )}
        </div>
      </button>

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
