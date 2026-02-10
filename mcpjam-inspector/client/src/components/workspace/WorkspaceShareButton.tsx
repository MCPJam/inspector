import { useState } from "react";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { ShareWorkspaceDialog } from "./ShareWorkspaceDialog";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
  const { user } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const posthog = usePostHog();
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const isShareEnabled = isAuthenticated && !!user;

  const handleClick = () => {
    posthog.capture("workspace_share_button_clicked", {
      workspace_name: workspaceName,
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    setIsShareDialogOpen(true);
  };

  return (
    <>
      {isShareEnabled ? (
        <Button size="sm" variant="outline" onClick={handleClick}>
          <Users className="h-4 w-4 mr-2" />
          Share
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button size="sm" variant="outline" disabled>
                <Users className="h-4 w-4 mr-2" />
                Share
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Log in to share</TooltipContent>
        </Tooltip>
      )}
      {isShareEnabled && user && (
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
