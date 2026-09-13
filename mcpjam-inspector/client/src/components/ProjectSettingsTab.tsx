import { ChevronDown } from "lucide-react";
import { useSettingsDraft } from "./settings/SettingsDraftProvider";
import {
  useCurrentPathname,
  useCurrentSearchParam,
} from "@/lib/app-navigation";
import { SettingsPageShell } from "./settings/SettingsPageShell";
import { useEffect, useState } from "react";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { ProjectGeneralDetails } from "./project/ProjectGeneralDetails";
import { ShareProjectDialog } from "./project/ShareProjectDialog";

import { ProjectIconPicker } from "./project/ProjectEmojiPicker";
import { ProjectSecretsSection } from "./project/ProjectSecretsSection";

import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
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

/**
 * Admin-gated project default for the MCPJam test IdP's simulated identity.
 * Convex-backed projects only — local project persistence is a no-op for
 * this field, so the section is hidden there. Saves are atomic: both fields
 * or neither; an explicit clear sends `xaaTestDefaults: null`.
 */
function XaaTestDefaultsSection({
  projectId,
  storedIdentity,
  canManage,
  onUpdateProject,
}: {
  projectId: string;
  storedIdentity: { subject: string; email: string } | undefined;
  canManage: boolean;
  onUpdateProject: (
    projectId: string,
    updates: Partial<Project>,
  ) => Promise<void>;
}) {
  const target = useCurrentSearchParam("setting");
  const [expanded, setExpanded] = useState(target === "test-identity");
  useEffect(() => {
    if (target === "test-identity") setExpanded(true);
  }, [target]);
  const [subject, setSubject] = useState(storedIdentity?.subject ?? "");
  const [email, setEmail] = useState(storedIdentity?.email ?? "");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Re-sync the draft when the stored default changes underneath us
  // (another admin saved, or the active project switched).
  const storedKey = `${projectId}|${storedIdentity?.subject ?? ""}|${
    storedIdentity?.email ?? ""
  }`;
  useEffect(() => {
    setSubject(storedIdentity?.subject ?? "");
    setEmail(storedIdentity?.email ?? "");
    setValidationError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  const trimmedSubject = subject.trim();
  const trimmedEmail = email.trim();
  const hasStored = Boolean(storedIdentity);
  const isDirty =
    trimmedSubject !== (storedIdentity?.subject ?? "") ||
    trimmedEmail !== (storedIdentity?.email ?? "");

  useSettingsDraft(
    isDirty,
    () => {
      setSubject(storedIdentity?.subject ?? "");
      setEmail(storedIdentity?.email ?? "");
    },
    isSaving,
  );

  const handleSave = async () => {
    const bothSet = trimmedSubject !== "" && trimmedEmail !== "";
    const bothEmpty = trimmedSubject === "" && trimmedEmail === "";
    if (!bothSet && !bothEmpty) {
      setValidationError(
        "Enter both a subject and an email, or clear both fields.",
      );
      return;
    }
    setValidationError(null);
    setIsSaving(true);
    try {
      await onUpdateProject(projectId, {
        xaaTestDefaults: bothSet
          ? {
              defaultIdentity: { subject: trimmedSubject, email: trimmedEmail },
            }
          : // Explicit clear — the mutation removes the stored default.
            null,
      });
    } catch {
      // onUpdateProject (handleUpdateProject) already surfaces a toast and
      // rethrows; swallow here so the `void handleSave()` caller doesn't leave
      // an unobserved rejection. The edited values stay in the form for retry.
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div id="setting-test-identity" className="space-y-2">
      <h2>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="test-identity-fields"
          className="flex w-full items-center justify-between gap-3 rounded-md border border-border px-4 py-3 text-left text-sm font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded(!expanded)}
        >
          <span>XAA test identity defaults</span>
          <ChevronDown
            aria-hidden="true"
            className={`size-4 shrink-0 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </button>
      </h2>
      <p className="px-4 text-xs text-muted-foreground">
        Default test identity for this project’s XAA connections.
      </p>
      {expanded && (
        <div id="test-identity-fields">
          <div className="space-y-3 px-4 py-3 rounded-md border border-border/40">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">MCPJam Test IdP</span>
              <span className="text-xs text-muted-foreground">
                Used when an authenticated project member connects without a
                server override.
              </span>
              {!hasStored && (
                <span className="text-xs text-muted-foreground">
                  Falls back to MCPJam&apos;s demo identity.
                </span>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label
                  htmlFor="xaa-default-subject"
                  className="block text-xs font-medium text-foreground"
                >
                  Subject (sub)
                </label>
                <Input
                  id="xaa-default-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Stable synthetic identifier"
                  disabled={!canManage}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-9"
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="xaa-default-email"
                  className="block text-xs font-medium text-foreground"
                >
                  Email
                </label>
                <Input
                  id="xaa-default-email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="synthetic.user@example.com"
                  disabled={!canManage}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-9"
                />
              </div>
            </div>
            {validationError && (
              <p className="text-xs text-red-500" role="alert">
                {validationError}
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                {canManage
                  ? "This does not configure enterprise SSO or bring-your-own IdP endpoints."
                  : "Only project admins can change these defaults."}
              </span>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSave()}
                disabled={!canManage || isSaving || !isDirty}
              >
                {isSaving ? "Saving…" : "Save defaults"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

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
  onProjectShared: (sharedProjectId: string, sourceProjectId?: string) => void;
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
  const pathname = useCurrentPathname();
  const section = pathname.endsWith("/members")
    ? "members"
    : pathname.endsWith("/secrets")
      ? "secrets"
      : "general";
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
    <SettingsPageShell>
      {section === "general" && (
        <ProjectGeneralDetails
          key={activeProjectId}
          name={projectName}
          description={projectDescription}
          canEdit={canManageProjectSettings}
          onSave={(details) => onUpdateProject(activeProjectId, details)}
          icon={
            <ProjectIconPicker
              currentIcon={project?.icon}
              projectName={projectName}
              onSelect={(iconName) =>
                onUpdateProject(activeProjectId, { icon: iconName })
              }
              onRemove={() => onUpdateProject(activeProjectId, { icon: "" })}
              size="sm"
            />
          }
        />
      )}
      {/* Members & Sharing */}
      {section === "members" && isAuthenticated && user && (
        <ShareProjectDialog
          embedded
          isOpen
          onClose={() => {}}
          projectName={projectName}
          projectServers={projectServers}
          sharedProjectId={project?.sharedProjectId}
          organizationId={project?.organizationId}
          visibility={project?.visibility}
          organizationName={organizationName}
          currentUser={user}
          onProjectShared={onProjectShared}
        />
      )}

      {/* Project secrets — Convex-backed projects only: the store is a
            Convex table, and a local project has nowhere to keep one. Shown to
            every member rather than admins alone, because PERSONAL secrets are
            owner-managed; `canManageShared` is what gates the project-shared
            option inside the form. */}
      {section === "secrets" && isAuthenticated && convexProjectId && (
        <ProjectSecretsSection
          key={convexProjectId ?? activeProjectId ?? "no-project"}
          projectId={convexProjectId}
          canManageShared={canManageMembers}
        />
      )}

      {/* XAA test identity defaults — Convex-backed projects only (the
            local-project update path is a no-op for this field). */}
      {section === "general" && isAuthenticated && convexProjectId && (
        <XaaTestDefaultsSection
          projectId={convexProjectId}
          storedIdentity={project?.xaaTestDefaults?.defaultIdentity}
          canManage={canManageMembers}
          onUpdateProject={onUpdateProject}
        />
      )}

      {/* Auto-connect is a personal per-device switch on the Servers tab
            header (next to "Add Server"), not a project setting. */}

      {/* Danger Zone */}
      {section === "general" && (
        <div className="max-w-2xl space-y-4 border-t border-border pt-7">
          <h2 className="text-lg font-semibold text-accent-foreground">
            Danger zone
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
                      const success = await onDeleteProject(activeProjectId);
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
      )}
    </SettingsPageShell>
  );
}
