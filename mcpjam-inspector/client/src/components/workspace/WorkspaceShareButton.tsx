import { useState } from "react";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { ShareWorkspaceDialog } from "./ShareWorkspaceDialog";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";

interface WorkspaceShareButtonProps {
  workspaceName: string;
  workspaceServers: Record<string, any>;
  sharedWorkspaceId?: string | null;
  onWorkspaceShared?: (sharedWorkspaceId: string) => void;
  onLeaveWorkspace?: () => void;
}

export function WorkspaceShareButton({
  workspaceName,
  workspaceServers,
  sharedWorkspaceId,
  onWorkspaceShared,
  onLeaveWorkspace,
}: WorkspaceShareButtonProps) {
  const { user, signIn } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const posthog = usePostHog();
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);

  const handleClick = () => {
    posthog.capture("workspace_share_button_clicked", {
      workspace_name: workspaceName,
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    if (!isAuthenticated || !user) {
      signIn();
      return;
    }
    setIsShareDialogOpen(true);
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={handleClick}>
        <Users className="h-4 w-4 mr-2" />
        Share
      </Button>
      {isAuthenticated && user && (
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
      )}
    </>
  );
}
