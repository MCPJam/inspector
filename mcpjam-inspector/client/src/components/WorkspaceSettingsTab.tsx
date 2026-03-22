import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { EditableText } from "./ui/editable-text";
import { AccountApiKeySection } from "./setting/AccountApiKeySection";
import { WorkspaceMembersFacepile } from "./workspace/WorkspaceMembersFacepile";
import { WorkspaceShareButton } from "./workspace/WorkspaceShareButton";
import { WorkspaceIconPicker } from "./workspace/WorkspaceEmojiPicker";

import { Button } from "./ui/button";
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
} from "./ui/alert-dialog";
import type { Workspace } from "@/state/app-types";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useWorkspaceMembers } from "@/hooks/useWorkspaces";

interface WorkspaceSettingsTabProps {
  activeWorkspaceId: string;
  workspace: Workspace | undefined;
  convexWorkspaceId: string | null;
  workspaceServers: Record<string, ServerWithName>;
  organizationName?: string;
  onUpdateWorkspace: (
    workspaceId: string,
    updates: Partial<Workspace>,
  ) => Promise<void>;
  onDeleteWorkspace: (workspaceId: string) => Promise<boolean>;
  onWorkspaceShared: (sharedWorkspaceId: string) => void;
  onNavigateAway: () => void;
}

export function WorkspaceSettingsTab({
  activeWorkspaceId,
  workspace,
  convexWorkspaceId,
  workspaceServers,
  organizationName,
  onUpdateWorkspace,
  onDeleteWorkspace,
  onWorkspaceShared,
  onNavigateAway,
}: WorkspaceSettingsTabProps) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const { activeMembers, canManageMembers } = useWorkspaceMembers({
    isAuthenticated,
    workspaceId: convexWorkspaceId,
  });

  const workspaceName = workspace?.name ?? "";
  const workspaceDescription = workspace?.description ?? "";
  const isDefault = workspace?.isDefault ?? false;
  const currentMember = activeMembers.find(
    (member) => member.email.toLowerCase() === user?.email?.toLowerCase(),
  );
  const canManageWorkspaceSettings =
    !isAuthenticated || !convexWorkspaceId ? true : canManageMembers;
  const canDeleteWorkspace =
    !isAuthenticated || !convexWorkspaceId
      ? true
      : currentMember?.role === "owner" || currentMember?.role === "admin";

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-8 max-w-4xl space-y-8">
        {/* Hero — Asana-style header */}
        <div className="flex items-start gap-6">
          <WorkspaceIconPicker
            currentIcon={workspace?.icon}
            workspaceName={workspaceName}
            onSelect={(iconName) =>
              onUpdateWorkspace(activeWorkspaceId, { icon: iconName })
            }
            onRemove={() => onUpdateWorkspace(activeWorkspaceId, { icon: "" })}
            size="lg"
          />
          <div className="flex flex-1 flex-col items-stretch gap-1 pt-2">
            <EditableText
              value={workspaceName}
              onSave={(newName) =>
                onUpdateWorkspace(activeWorkspaceId, { name: newName })
              }
              disabled={!canManageWorkspaceSettings}
              className="w-full text-3xl font-semibold -ml-2"
              placeholder="Workspace name"
            />
            <EditableText
              value={workspaceDescription}
              onSave={(newDesc) =>
                onUpdateWorkspace(activeWorkspaceId, {
                  description: newDesc,
                })
              }
              disabled={!canManageWorkspaceSettings}
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
                <WorkspaceMembersFacepile
                  workspaceName={workspaceName}
                  workspaceServers={workspaceServers}
                  currentUser={user}
                  sharedWorkspaceId={workspace?.sharedWorkspaceId}
                  organizationId={workspace?.organizationId}
                  visibility={workspace?.visibility}
                  organizationName={organizationName}
                  onWorkspaceShared={onWorkspaceShared}
                />
              )}
              <WorkspaceShareButton
                workspaceName={workspaceName}
                workspaceServers={workspaceServers}
                sharedWorkspaceId={workspace?.sharedWorkspaceId}
                organizationId={workspace?.organizationId}
                visibility={workspace?.visibility}
                organizationName={organizationName}
                onWorkspaceShared={onWorkspaceShared}
              />
            </div>
          </div>
        )}

        {/* API Key */}
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">API Key</h2>
          <AccountApiKeySection
            workspaceId={convexWorkspaceId}
            workspaceName={workspaceName || null}
          />
        </div>

        {/* Danger Zone */}
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Danger Zone
          </h2>
          <div className="flex items-center justify-between px-4 py-3 rounded-md border border-destructive/30">
            <div className="flex flex-col">
              <span className="text-sm font-medium">Delete workspace</span>
              <span className="text-xs text-muted-foreground">
                {isDefault
                  ? "Switch to another workspace first"
                  : !canDeleteWorkspace
                    ? "Only organization admins can delete this workspace"
                    : "Permanently delete this workspace and all its data"}
              </span>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={isDefault || !canDeleteWorkspace}
                >
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete workspace?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete &ldquo;{workspaceName}
                    &rdquo; and all its servers. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={async () => {
                      const success =
                        await onDeleteWorkspace(activeWorkspaceId);
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
