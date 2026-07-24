import { useMutation, useQuery, useConvexAuth } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { shouldQueryProjectId } from "@/hooks/useProjects";

/**
 * Client hooks for **Project environments** (mcpjam-backend
 * `convex/projectEnvironments.ts`) — named, project-scoped, live-editable
 * bundles of one host + optional standalone server group + optional pinned
 * skill selection. Suites and journeys reference environments by id and the
 * backend resolves/pins them at run start.
 *
 * NOT the same thing as Computer environments (`useComputerEnvironments.ts`,
 * the e2b/Docker sandbox images — relabeled "Sandbox images" in UI). Like
 * every backend surface here, Convex functions are referenced by string id;
 * the types below are hand-mirrored (no codegen).
 */

export type ProjectEnvironmentSkillSelection = {
  mode: "explicit";
  skillIds: string[];
};

export interface ProjectEnvironmentView {
  environmentId: string;
  projectId: string;
  name: string;
  description?: string;
  /** Exactly one host per environment. */
  hostId: string;
  /** Resolved for display by the backend list/get queries (wire-tolerant). */
  hostName?: string | null;
  /** Standalone server group scope; absent ⇒ the host's own server picks. */
  serverAttachmentId?: string | null;
  /** Additive standalone skill channel; absent ⇒ no env-channel skills. */
  skillSelection?: ProjectEnvironmentSkillSelection | null;
  /** Bumped on every effective edit; optimistic-concurrency token. */
  revision: number;
  /** Present ⇒ archived (hidden from pickers; launches fail fast). */
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Environments for a project. The management route passes
 * `includeArchived: true`; suite/journey pickers use the live-only default.
 * `undefined` while loading or when the query is skipped.
 */
export function useProjectEnvironments(
  projectId: string | null,
  options?: { includeArchived?: boolean }
): ProjectEnvironmentView[] | undefined {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const enableQuery =
    isAuthenticated && isUserReady && shouldQueryProjectId(projectId);
  return useQuery(
    "projectEnvironments:listEnvironments" as any,
    enableQuery
      ? ({
          projectId,
          ...(options?.includeArchived ? { includeArchived: true } : {}),
        } as any)
      : "skip"
  ) as ProjectEnvironmentView[] | undefined;
}

/** One environment, or `null` when not visible. */
export function useProjectEnvironment(
  environmentId: string | null
): ProjectEnvironmentView | null | undefined {
  return useQuery(
    "projectEnvironments:getEnvironment" as any,
    environmentId ? ({ environmentId } as any) : "skip"
  ) as ProjectEnvironmentView | null | undefined;
}

export function useCreateProjectEnvironment(): (args: {
  projectId: string;
  name: string;
  description?: string;
  hostId: string;
  serverAttachmentId?: string | null;
  skillSelection?: ProjectEnvironmentSkillSelection | null;
}) => Promise<ProjectEnvironmentView> {
  return useMutation("projectEnvironments:createEnvironment" as any) as never;
}

/**
 * Update takes `expectedRevision` — the repo's expectedRevision pattern:
 * capture the row's revision when the editor DRAFT is initialized/reset and
 * send THAT captured value, never the newest reactive revision at submit
 * time (substituting the fresh revision would let a stale draft silently
 * overwrite a concurrent edit). On {@link isRevisionConflictError}, surface
 * the conflict and reinitialize only after user confirmation — never
 * auto-retry a stale patch.
 */
export function useUpdateProjectEnvironment(): (args: {
  environmentId: string;
  expectedRevision: number;
  name?: string;
  description?: string | null;
  hostId?: string;
  serverAttachmentId?: string | null;
  skillSelection?: ProjectEnvironmentSkillSelection | null;
}) => Promise<ProjectEnvironmentView> {
  return useMutation("projectEnvironments:updateEnvironment" as any) as never;
}

export function useArchiveProjectEnvironment(): (args: {
  environmentId: string;
  expectedRevision: number;
}) => Promise<ProjectEnvironmentView> {
  return useMutation("projectEnvironments:archiveEnvironment" as any) as never;
}

export function useRestoreProjectEnvironment(): (args: {
  environmentId: string;
  expectedRevision: number;
}) => Promise<ProjectEnvironmentView> {
  return useMutation("projectEnvironments:restoreEnvironment" as any) as never;
}

/**
 * True when a mutation rejection is the backend's stale-`expectedRevision`
 * conflict. Wire-tolerant: matches the structured ConvexError code first and
 * falls back to a message probe so a backend code rename degrades to a
 * still-correct conflict toast rather than a generic failure.
 */
export function isRevisionConflictError(err: unknown): boolean {
  const data = (err as { data?: unknown } | null)?.data;
  if (data && typeof data === "object") {
    const code = (data as { code?: unknown }).code;
    if (
      code === "CONFLICT" ||
      code === "REVISION_CONFLICT" ||
      code === "ENV_REVISION_CONFLICT"
    ) {
      return true;
    }
  }
  const message =
    typeof data === "string" ? data : err instanceof Error ? err.message : "";
  return /revision/i.test(message) && /conflict|stale|changed/i.test(message);
}
