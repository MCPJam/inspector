import { useMemo } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import type { ProjectVisibility } from "@/state/app-types";
import type { ProjectClientConfig } from "@/lib/client-config";

export type ProjectMembershipRole = "owner" | "admin" | "member" | "guest";
export type ProjectRole = "admin" | "editor";
export type ProjectMemberAccessSource = "organization" | "project" | "invite";

export interface RemoteProject {
  _id: string;
  name: string;
  description?: string;
  icon?: string;
  clientConfig?: ProjectClientConfig;
  servers: Record<string, any>;
  canDeleteProject?: boolean;
  organizationId: string;
  visibility?: ProjectVisibility;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

// Flat server structure from the servers table
export interface RemoteServer {
  _id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  transportType: "stdio" | "http";
  // STDIO fields
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // HTTP fields
  url?: string;
  headers?: Record<string, string>;
  // Shared fields
  timeout?: number;
  clientCapabilities?: Record<string, unknown>;
  // OAuth fields
  useOAuth?: boolean;
  oauthScopes?: string[];
  clientId?: string;
  hasClientSecret?: boolean;
  oauthResourceUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectMember {
  _id: string;
  projectId: string;
  organizationId?: string;
  userId?: string;
  email: string;
  role?: ProjectMembershipRole;
  projectRole: ProjectRole;
  canChangeRole: boolean;
  addedBy: string;
  addedAt: number;
  revokedAt?: number;
  isOwner: boolean;
  isPending: boolean;
  hasAccess: boolean;
  accessSource: ProjectMemberAccessSource;
  canRemove: boolean;
  user: {
    name: string;
    email: string;
    imageUrl: string;
  } | null;
}

interface ProjectMembersQueryResult {
  members: ProjectMember[];
  canManageMembers: boolean;
}

const INVALID_PROJECT_ID_SENTINELS = new Set(["none", "null", "undefined"]);
const UUID_PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_PROJECT_ID_PREFIXES = ["local_", "project_"];

export function shouldQueryProjectId(projectId: string | null | undefined) {
  const normalized = projectId?.trim();
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  return Boolean(
    !INVALID_PROJECT_ID_SENTINELS.has(lower) &&
      !UUID_PROJECT_ID_PATTERN.test(normalized) &&
      !LOCAL_PROJECT_ID_PREFIXES.some((prefix) => lower.startsWith(prefix)),
  );
}

function isProjectMembersQueryResult(
  value: unknown
): value is ProjectMembersQueryResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as ProjectMembersQueryResult).members)
  );
}

export function normalizeProjectMembersResult(
  value: ProjectMember[] | ProjectMembersQueryResult | undefined
): ProjectMembersQueryResult {
  if (Array.isArray(value)) {
    return { members: value, canManageMembers: false };
  }

  if (isProjectMembersQueryResult(value)) {
    return {
      members: value.members,
      canManageMembers: value.canManageMembers,
    };
  }

  return { members: [], canManageMembers: false };
}

export function filterProjectsForOrganization(
  projects: RemoteProject[] | undefined,
  organizationId?: string
) {
  if (!projects || !organizationId) return projects;

  return projects.filter(
    (project) => project.organizationId === organizationId
  );
}

export function useProjectQueries({
  isAuthenticated,
  organizationId,
}: {
  isAuthenticated: boolean;
  organizationId?: string;
}) {
  const queriedProjects = useQuery(
    "projects:getMyProjects" as any,
    isAuthenticated ? ({} as any) : "skip"
  ) as RemoteProject[] | undefined;

  const isLoading = isAuthenticated && queriedProjects === undefined;

  const projects = useMemo(
    () => filterProjectsForOrganization(queriedProjects, organizationId),
    [queriedProjects, organizationId]
  );

  const sortedProjects = useMemo(() => {
    if (!projects) return [];
    return [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [projects]);

  return {
    allProjects: queriedProjects,
    projects,
    sortedProjects,
    isLoading,
    hasProjects: (projects?.length ?? 0) > 0,
    hasAnyProjects: (queriedProjects?.length ?? 0) > 0,
  };
}

export function useProjectMembers({
  isAuthenticated,
  projectId,
}: {
  isAuthenticated: boolean;
  projectId: string | null;
}) {
  const enableQuery = isAuthenticated && !!projectId;

  const membersResult = useQuery(
    "projects:getProjectMembers" as any,
    enableQuery ? ({ projectId } as any) : "skip"
  ) as ProjectMember[] | ProjectMembersQueryResult | undefined;

  const isLoading = enableQuery && membersResult === undefined;

  const { members, canManageMembers } = useMemo(
    () => normalizeProjectMembersResult(membersResult),
    [membersResult]
  );

  const activeMembers = useMemo(() => {
    if (!members) return [];
    return members.filter((m) => !m.isPending);
  }, [members]);

  const pendingMembers = useMemo(() => {
    if (!members) return [];
    return members.filter((m) => m.isPending);
  }, [members]);

  return {
    members,
    activeMembers,
    pendingMembers,
    canManageMembers,
    isLoading,
    hasPendingMembers: pendingMembers.length > 0,
  };
}

export function useProjectMutations() {
  const createProject = useMutation("projects:createProject" as any);
  const ensureDefaultProject = useMutation(
    "projects:ensureDefaultProject" as any
  );
  const updateProject = useMutation("projects:updateProject" as any);
  // Phase 4: write the project default's connection portion through the
  // v2 owner pointer. The legacy `projects:updateProjectClientConfig`
  // is still exported by the backend as a compat wrapper but the
  // inspector no longer calls it.
  const patchProjectDefaultConnection = useMutation(
    "hostConfigsV2:patchProjectDefaultConnection" as any
  );
  const deleteProject = useMutation("projects:deleteProject" as any);
  const inviteProjectMember = useMutation(
    "projects:inviteProjectMember" as any
  );
  const removeProjectMember = useMutation(
    "projects:removeProjectMember" as any
  );
  const updateProjectMemberRole = useMutation(
    "projects:updateProjectMemberRole" as any
  );
  const updateProjectInviteRole = useMutation(
    "projects:updateProjectInviteRole" as any
  );

  return {
    createProject,
    ensureDefaultProject,
    updateProject,
    patchProjectDefaultConnection,
    deleteProject,
    inviteProjectMember,
    removeProjectMember,
    updateProjectMemberRole,
    updateProjectInviteRole,
  };
}

// Server mutations for the flat servers table
export function useServerMutations() {
  const createServer = useMutation("servers:createServer" as any);
  const updateServer = useMutation("servers:updateServer" as any);
  const deleteServer = useMutation("servers:deleteServer" as any);
  const createServerWithClientSecret = useAction(
    "servers:createServerWithClientSecret" as any,
  );
  const updateServerWithClientSecret = useAction(
    "servers:updateServerWithClientSecret" as any,
  );

  return {
    createServer,
    updateServer,
    createServerWithClientSecret,
    updateServerWithClientSecret,
    deleteServer,
  };
}

export function useProjectServers({
  projectId,
  isAuthenticated,
}: {
  projectId: string | null;
  isAuthenticated: boolean;
}) {
  const shouldQuery = isAuthenticated && shouldQueryProjectId(projectId);
  const queryProjectId = projectId?.trim() ?? "";

  const servers = useQuery(
    "servers:getProjectServers" as any,
    shouldQuery ? ({ projectId: queryProjectId } as any) : "skip"
  ) as RemoteServer[] | undefined;

  const isLoading = shouldQuery && servers === undefined;

  // Convert array to record keyed by server name
  const serversRecord = useMemo(() => {
    if (!servers) return {};
    return Object.fromEntries(servers.map((s) => [s.name, s]));
  }, [servers]);

  return {
    servers,
    serversRecord,
    isLoading,
    hasServers: (servers?.length ?? 0) > 0,
  };
}

// Bulk-fetch servers for many projects in one call. Replaces the embedded
// servers blob the project picker used to read off each `RemoteProject`.
// The backend cap is 500 ids; we dedupe + slice here so the picker can pass
// a raw project list without worrying about either constraint.
export function useProjectsBulkServers({
  projectIds,
  isAuthenticated,
}: {
  projectIds: string[];
  isAuthenticated: boolean;
}) {
  // Stable identity for the query args. Using a joined key in the dependency
  // list avoids re-running the memo when the input array reference flips but
  // the contents are the same.
  const stableKey = projectIds.join("|");
  const stableProjectIds = useMemo(() => {
    if (projectIds.length === 0) return [] as string[];
    return Array.from(new Set(projectIds)).slice(0, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableKey]);

  const data = useQuery(
    "servers:listForProjects" as any,
    isAuthenticated && stableProjectIds.length > 0
      ? ({ projectIds: stableProjectIds } as any)
      : "skip"
  ) as Record<string, RemoteServer[]> | undefined;

  const isLoading =
    isAuthenticated && stableProjectIds.length > 0 && data === undefined;

  const serversByProject = useMemo<Record<string, RemoteServer[]>>(
    () => data ?? {},
    [data]
  );

  return {
    serversByProject,
    isLoading,
  };
}
