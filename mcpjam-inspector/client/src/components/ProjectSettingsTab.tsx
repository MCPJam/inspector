import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { EditableText } from "./ui/editable-text";
import { AccountApiKeySection } from "./setting/AccountApiKeySection";
import { ProjectSlackIntegrationSection } from "./setting/ProjectSlackIntegrationSection";
import { ProjectMembersFacepile } from "./project/ProjectMembersFacepile";
import { ProjectShareButton } from "./project/ProjectShareButton";
import { ProjectIconPicker } from "./project/ProjectEmojiPicker";
import { ProjectDefaultHostConfigSection } from "./host-config/ProjectDefaultHostConfigSection";

import { Button } from "@mcpjam/design-system/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@mcpjam/design-system/alert-dialog";
import type { Project } from "@/state/app-types";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useProjectMembers } from "@/hooks/useProjects";

interface ProjectSettingsTabProps {
  activeProjectId: string;
  project: Project | undefined;
  convexProjectId: string | null;
  projectServers: Record<string, ServerWithName>;
  organizationName?: string;
  onUpdateProject: (
    projectId: string,
    updates: Partial<Project>,
  ) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<boolean>;
  onProjectShared: (
    sharedProjectId: string,
    sourceProjectId?: string,
  ) => void;
  onNavigateAway: () => void;
}

export function ProjectSettingsTab({
  activeProjectId,
  project,
  convexProjectId,
  projectServers,
  organizationName,
  onUpdateProject,
  onDeleteProject,
  onProjectShared,
  onNavigateAway,
}: ProjectSettingsTabProps) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const { activeMembers, canManageMembers } = useProjectMembers({
    isAuthenticated,
    projectId: convexProjectId,
  });

  const projectName = project?.name ?? "";
  const projectDescription = project?.description ?? "";
  const isDefault = project?.isDefault ?? false;
  const currentMember = activeMembers.find(
    (member) => member.email.toLowerCase() === user?.email?.toLowerCase(),
  );
  const canManageProjectSettings =
    !isAuthenticated || !convexProjectId ? true : canManageMembers;
  const canDeleteProject =
    project?.canDeleteProject ??
    (!isAuthenticated || !convexProjectId
      ? true
      : currentMember?.role === "owner" ||
        currentMember?.role === "admin" ||
        currentMember?.projectRole === "admin");

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-8 max-w-4xl space-y-8">
        {/* Hero — Asana-style header */}
        <div className="flex items-start gap-6">
          <ProjectIconPicker
            currentIcon={project?.icon}
            projectName={projectName}
            onSelect={(iconName) =>
              onUpdateProject(activeProjectId, { icon: iconName })
            }
            onRemove={() => onUpdateProject(activeProjectId, { icon: "" })}
            size="lg"
          />
          <div className="flex flex-1 flex-col items-stretch gap-1 pt-2">
            <EditableText
              value={projectName}
              onSave={(newName) =>
                onUpdateProject(activeProjectId, { name: newName })
              }
              disabled={!canManageProjectSettings}
              className="w-full text-3xl font-semibold -ml-2"
              placeholder="Project name"
            />
            <EditableText
              value={projectDescription}
              onSave={(newDesc) =>
                onUpdateProject(activeProjectId, {
                  description: newDesc,
                })
              }
              disabled={!canManageProjectSettings}
              className="w-full text-muted-foreground -ml-2"
              placeholder="Add a description..."
            />
          </div>
        </div>

        {/* Members & Sharing */}
        {isAuthenticated && (
          <div className="space-y-2">
            <h2 className="text-sm font-medium text-muted-foreground">
              Members & Sharing
            </h2>
            <div className="flex items-center gap-2 px-4 py-3 rounded-md border border-border/40">
              {user && (
                <ProjectMembersFacepile
                  projectName={projectName}
                  projectServers={projectServers}
                  currentUser={user}
                  sharedProjectId={project?.sharedProjectId}
                  organizationId={project?.organizationId}
                  visibility={project?.visibility}
                  organizationName={organizationName}
                  onProjectShared={onProjectShared}
                />
              )}
              <ProjectShareButton
                projectName={projectName}
                projectServers={projectServers}
                sharedProjectId={project?.sharedProjectId}
                organizationId={project?.organizationId}
                visibility={project?.visibility}
                organizationName={organizationName}
                onProjectShared={onProjectShared}
              />
            </div>
          </div>
        )}

        {/* API Key */}
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">API Key</h2>
          <AccountApiKeySection
            projectId={convexProjectId}
            projectName={projectName || null}
          />
        </div>

        {/* Integrations */}
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Integrations
          </h2>
          <ProjectSlackIntegrationSection
            projectId={convexProjectId}
            projectName={projectName || null}
            organizationId={project?.organizationId}
            canManageIntegration={canManageMembers}
          />
        </div>

        {/* Default Host Config — seed for new chatboxes, eval suites,
            and direct chat tabs. Editing it does not change existing
            chatboxes or suites. */}
        {isAuthenticated && convexProjectId ? (
          <ProjectDefaultHostConfigSection
            convexProjectId={convexProjectId}
            projectServers={projectServers}
            canManage={canManageProjectSettings}
          />
        ) : null}

        {/* Danger Zone */}
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Danger Zone
          </h2>
          <div className="flex items-center justify-between px-4 py-3 rounded-md border border-destructive/30">
            <div className="flex flex-col">
              <span className="text-sm font-medium">Delete project</span>
              <span className="text-xs text-muted-foreground">
                {isDefault
                  ? "Switch to another project first"
                  : !canDeleteProject
                    ? "Only project admins can delete this project"
                    : "Permanently delete this project and all its data"}
              </span>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={isDefault || !canDeleteProject}
                >
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete project?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete &ldquo;{projectName}
                    &rdquo; and all its servers. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={async () => {
                      const success =
                        await onDeleteProject(activeProjectId);
                      if (success) {
                        onNavigateAway();
                      }
                    }}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>
    </div>
  );
}
