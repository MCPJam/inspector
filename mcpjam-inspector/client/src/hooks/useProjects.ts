import { useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
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
  const updateClientConfig = useMutation(
    "projects:updateProjectClientConfig" as any
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
    updateClientConfig,
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

  return {
    createServer,
    updateServer,
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
  const servers = useQuery(
    "servers:getProjectServers" as any,
    isAuthenticated && projectId ? ({ projectId } as any) : "skip"
  ) as RemoteServer[] | undefined;

  const isLoading = isAuthenticated && projectId && servers === undefined;

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
