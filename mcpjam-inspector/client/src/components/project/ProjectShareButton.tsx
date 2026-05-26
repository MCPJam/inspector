import { useState } from "react";
import { Users } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { ShareProjectDialog } from "./ShareProjectDialog";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { ProjectVisibility } from "@/state/app-types";

interface ProjectShareButtonProps {
  projectName: string;
  projectServers: Record<string, any>;
  sharedProjectId?: string | null;
  organizationId?: string;
  visibility?: ProjectVisibility;
  organizationName?: string;
  onProjectShared?: (
    sharedProjectId: string,
    sourceProjectId?: string,
  ) => void;
}

export function ProjectShareButton({
  projectName,
  projectServers,
  sharedProjectId,
  organizationId,
  visibility,
  organizationName,
  onProjectShared,
}: ProjectShareButtonProps) {
  const { user } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const posthog = usePostHog();
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const isShareEnabled = isAuthenticated && !!user;

  const handleClick = () => {
    posthog.capture("project_share_button_clicked", {
      project_name: projectName,
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
        <ShareProjectDialog
          isOpen={isShareDialogOpen}
          onClose={() => setIsShareDialogOpen(false)}
          projectName={projectName}
          projectServers={projectServers}
          sharedProjectId={sharedProjectId}
          organizationId={organizationId}
          visibility={visibility}
          organizationName={organizationName}
          currentUser={user}
          onProjectShared={onProjectShared}
        />
      )}
    </>
  );
}
