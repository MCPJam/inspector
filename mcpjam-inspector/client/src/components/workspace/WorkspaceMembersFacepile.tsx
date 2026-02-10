import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";
import { Users } from "lucide-react";
import { ShareWorkspaceDialog } from "./ShareWorkspaceDialog";
import { useWorkspaceMembers } from "@/hooks/useWorkspaces";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import { cn } from "@/lib/utils";
import { User } from "@workos-inc/authkit-js";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";

interface WorkspaceMembersFacepileProps {
  workspaceName: string;
  workspaceServers: Record<string, any>;
  currentUser: User;
  sharedWorkspaceId?: string | null;
  onWorkspaceShared?: (sharedWorkspaceId: string) => void;
  onLeaveWorkspace?: () => void;
}

export function WorkspaceMembersFacepile({
  workspaceName,
  workspaceServers,
  currentUser,
  sharedWorkspaceId,
  onWorkspaceShared,
  onLeaveWorkspace,
}: WorkspaceMembersFacepileProps) {
  const { profilePictureUrl } = useProfilePicture();
  const posthog = usePostHog();
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);

  const handleFacepileClick = () => {
    posthog.capture("workspace_members_facepile_clicked", {
      workspace_name: workspaceName,
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    setIsShareDialogOpen(true);
  };

  const { activeMembers, isLoading } = useWorkspaceMembers({
    isAuthenticated: true,
    workspaceId: sharedWorkspaceId ?? null,
  });

  if (!sharedWorkspaceId) {
    const displayName = [currentUser.firstName, currentUser.lastName]
      .filter(Boolean)
      .join(" ");
    const initials = getInitials(displayName);

    return (
      <div className="flex items-center">
        <button
          onClick={handleFacepileClick}
          className="flex -space-x-2 hover:opacity-80 transition-opacity cursor-pointer"
        >
          <Avatar className="size-8 border-2 border-background">
            <AvatarImage src={profilePictureUrl} alt={displayName} />
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
          <div className="size-8 rounded-full border-2 border-background bg-muted flex items-center justify-center hover:bg-accent transition-colors">
            <Users className="size-3.5 text-muted-foreground" />
          </div>
        </button>
        <ShareWorkspaceDialog
          isOpen={isShareDialogOpen}
          onClose={() => setIsShareDialogOpen(false)}
          workspaceName={workspaceName}
          workspaceServers={workspaceServers}
          sharedWorkspaceId={sharedWorkspaceId}
          currentUser={currentUser}
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
        onClick={handleFacepileClick}
        className="flex -space-x-2 hover:opacity-80 transition-opacity cursor-pointer"
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
              <Users className="size-3.5 text-muted-foreground" />
              <span className="absolute -top-1 -right-1 size-4 rounded-full bg-primary text-[10px] font-medium text-primary-foreground flex items-center justify-center">
                {remainingCount > 9 ? "9+" : `+${remainingCount}`}
              </span>
            </>
          ) : (
            <Users className="size-3.5 text-muted-foreground" />
          )}
        </div>
      </button>

      <ShareWorkspaceDialog
        isOpen={isShareDialogOpen}
        onClose={() => setIsShareDialogOpen(false)}
        workspaceName={workspaceName}
        workspaceServers={workspaceServers}
        sharedWorkspaceId={sharedWorkspaceId}
        currentUser={currentUser}
        onWorkspaceShared={onWorkspaceShared}
        onLeaveWorkspace={onLeaveWorkspace}
      />
    </div>
  );
}
