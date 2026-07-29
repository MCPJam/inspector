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

/**
 * THE client mirror of a Project environment row. Every client surface
 * (management route, suite picker, swarms) imports this one — do not add a
 * second per-surface copy.
 *
 * This mirrors the CONVEX view shape (`environmentId`, `archivedAt`), which is
 * what the reactive queries below return. It is deliberately NOT the SDK's
 * `PlatformEnvironment`: that is the public `/api/v1` wire shape (`id`,
 * `archived: boolean`) and the browser never speaks that API.
 */
export interface ProjectEnvironmentView {
  environmentId: string;
  projectId: string;
  name: string;
  description?: string;
  /** Exactly one host per environment. */
  hostId: string;
  /** Standalone server group scope; absent ⇒ the host's own server picks. */
  serverAttachmentId?: string | null;
  /** Additive standalone skill channel; absent ⇒ no env-channel skills. */
  skillSelection?: ProjectEnvironmentSkillSelection | null;
  /**
   * Pinned plugin VERSION ids. Read-only from the client today — the editor
   * has no plugin-version picker yet, so edits must leave this field ABSENT
   * (undefined = unchanged) rather than sending it and clearing the pins.
   */
  pluginVersionIds?: string[];
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
  // Send the SAME normalized id `shouldQueryProjectId` validated — a
  // whitespace-padded id passes the guard but would target a different/invalid
  // project if forwarded raw.
  const normalizedProjectId = projectId?.trim() || null;
  const enableQuery =
    isAuthenticated && isUserReady && shouldQueryProjectId(normalizedProjectId);
  return useQuery(
    "projectEnvironments:listEnvironments" as any,
    enableQuery
      ? ({
          projectId: normalizedProjectId,
          ...(options?.includeArchived ? { includeArchived: true } : {}),
        } as any)
      : "skip"
  ) as ProjectEnvironmentView[] | undefined;
}

/**
 * One environment, or `null` when not visible.
 *
 * `projectId` is REQUIRED by the backend query: it scopes the lookup, so an id
 * from another of the caller's projects reads as not-found instead of leaking
 * across projects. Passing only the environment id fails validation.
 */
export function useProjectEnvironment(
  projectId: string | null,
  environmentId: string | null
): ProjectEnvironmentView | null | undefined {
  // Same gate as the list hook: without the auth/db-ready checks the query can
  // fire before the backend identity exists and fail rather than skip.
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  // Normalize BOTH ids for the same reason: a whitespace-padded value passes a
  // bare truthiness check but would target a different (invalid) row.
  const normalizedProjectId = projectId?.trim() || null;
  const normalizedEnvironmentId = environmentId?.trim() || null;
  const enableQuery =
    isAuthenticated &&
    isUserReady &&
    shouldQueryProjectId(normalizedProjectId) &&
    Boolean(normalizedEnvironmentId);
  return useQuery(
    "projectEnvironments:getEnvironment" as any,
    enableQuery
      ? ({
          projectId: normalizedProjectId,
          environmentId: normalizedEnvironmentId,
        } as any)
      : "skip"
  ) as ProjectEnvironmentView | null | undefined;
}

export function useCreateProjectEnvironment(): (args: {
  projectId: string;
  name: string;
  description?: string;
  hostId: string;
  serverAttachmentId?: string | null;
  skillSelection?: ProjectEnvironmentSkillSelection | null;
  /**
   * Pinned plugin versions. No editor control ships this yet; the argument
   * exists so the client mirror matches the backend contract. An empty array
   * is REJECTED by the backend — omit the field to mean "no pins".
   */
  pluginVersionIds?: string[];
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
  /**
   * Tri-state, like the other clearable fields: OMIT to leave the pins
   * untouched, `null` to clear them. Since no editor can author pins yet,
   * every current caller must omit it — sending `null` from a form that simply
   * doesn't render the control would silently drop pins the user set through
   * the API or CLI. An empty array is rejected by the backend.
   */
  pluginVersionIds?: string[] | null;
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

// ── Environment-backed chatbox (Phase 5, live-follow) ───────────────────────

/**
 * Projection returned by `chatboxes:publishEnvironmentChatbox` /
 * carried per-row by `chatboxes:listChatboxes` for env-backed rows. The
 * chatbox is a POINTER to the environment (no host-config pin): editing the
 * environment updates the published chatbox immediately, so there is no
 * revision captured here on purpose.
 */
export interface EnvironmentChatboxSummary {
  chatboxId: string;
  environmentId: string;
  name: string;
  mode: "anyone_with_link" | "invited_only" | "project_members";
  allowGuestAccess: boolean;
  link: { token: string; path: string; url: string } | null;
}

/**
 * The published chatbox for one environment, or `null` when unpublished.
 * Reads the project chatbox list (which carries `environmentId` per row since
 * mcpjam-backend #805) rather than a dedicated query — one-per-environment is
 * backend-enforced, so `find` is exact. `undefined` while loading; a backend
 * predating #805 never marks a row, which correctly reads as unpublished.
 */
export function useEnvironmentChatbox(
  projectId: string | null,
  environmentId: string | null
): EnvironmentChatboxSummary | null | undefined {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const normalizedProjectId = projectId?.trim() || null;
  const enableQuery =
    isAuthenticated &&
    isUserReady &&
    shouldQueryProjectId(normalizedProjectId) &&
    Boolean(environmentId?.trim());
  const chatboxes = useQuery(
    "chatboxes:listChatboxes" as any,
    enableQuery ? ({ projectId: normalizedProjectId } as any) : "skip"
  ) as
    | Array<{
        chatboxId: string;
        environmentId?: string | null;
        name: string;
        mode: EnvironmentChatboxSummary["mode"];
        allowGuestAccess: boolean;
        link?: { token: string; path: string; url: string } | null;
      }>
    | undefined;
  if (!enableQuery || chatboxes === undefined) return undefined;
  const row = chatboxes.find(
    (chatbox) => chatbox.environmentId === environmentId?.trim()
  );
  if (!row) return null;
  return {
    chatboxId: row.chatboxId,
    environmentId: environmentId!.trim(),
    name: row.name,
    mode: row.mode,
    allowGuestAccess: row.allowGuestAccess,
    link: row.link ?? null,
  };
}

/**
 * Publish an environment as a chatbox (project-admin gated, idempotent:
 * a second publish returns the existing row with `created: false`).
 */
export function usePublishEnvironmentChatbox(): (args: {
  environmentId: string;
}) => Promise<{
  chatboxId: string;
  environmentId: string;
  name: string;
  mode: EnvironmentChatboxSummary["mode"];
  accessVersion: number;
  link: { token: string; path: string; url: string } | null;
  created: boolean;
}> {
  return useMutation("chatboxes:publishEnvironmentChatbox" as any) as never;
}

/**
 * Unpublish: deletes the chatbox row + its cascade ONLY — the host and the
 * environment both survive (backend-guarded).
 */
export function useUnpublishEnvironmentChatbox(): (args: {
  environmentId: string;
}) => Promise<{ deleted: boolean; chatboxId?: string }> {
  return useMutation("chatboxes:unpublishEnvironmentChatbox" as any) as never;
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
