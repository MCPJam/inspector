import { useMemo } from "react";
import { useQuery, useMutation, useAction } from "convex/react";

export type OrganizationMembershipRole = "owner" | "admin" | "member";

export interface Organization {
  _id: string;
  name: string;
  description?: string;
  imageUrl?: string;
  logoUrl?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface OrganizationMember {
  _id: string;
  organizationId: string;
  userId?: string;
  email: string;
  role?: OrganizationMembershipRole;
  isOwner: boolean;
  addedBy: string;
  addedAt: number;
  user: {
    name: string;
    email: string;
    imageUrl: string;
  } | null;
}

export function resolveOrganizationRole(
  member: Pick<OrganizationMember, "role" | "isOwner">,
  role?: OrganizationMembershipRole,
): OrganizationMembershipRole {
  if (role) return role;
  if (member.role) return member.role;
  return member.isOwner ? "owner" : "member";
}

export function useOrganizationQueries({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const organizations = useQuery(
    "organizations:getMyOrganizations" as any,
    isAuthenticated ? ({} as any) : "skip",
  ) as Organization[] | undefined;

  const isLoading = isAuthenticated && organizations === undefined;

  const sortedOrganizations = useMemo(() => {
    if (!organizations) return [];
    return [...organizations].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [organizations]);

  return {
    sortedOrganizations,
    isLoading,
  };
}

export function useOrganizationMembers({
  isAuthenticated,
  organizationId,
}: {
  isAuthenticated: boolean;
  organizationId: string | null;
}) {
  const enableQuery = isAuthenticated && !!organizationId;

  const members = useQuery(
    "organizations:getOrganizationMembers" as any,
    enableQuery ? ({ organizationId } as any) : "skip",
  ) as OrganizationMember[] | undefined;

  const isLoading = enableQuery && members === undefined;

  const activeMembers = useMemo(() => {
    if (!members) return [];
    return members.filter((m) => m.userId !== undefined);
  }, [members]);

  const pendingMembers = useMemo(() => {
    if (!members) return [];
    return members.filter((m) => m.userId === undefined);
  }, [members]);

  return {
    activeMembers,
    pendingMembers,
    isLoading,
  };
}

export function useOrganizationMutations() {
  const createOrganization = useMutation(
    "organizations:createOrganization" as any,
  );
  const updateOrganization = useMutation(
    "organizations:updateOrganization" as any,
  );
  const deleteOrganization = useMutation(
    "organizations:deleteOrganization" as any,
  );
  const addMember = useMutation("organizations:addMember" as any);
  const changeMemberRole = useMutation("organizations:changeMemberRole" as any);
  const transferOrganizationOwnership = useMutation(
    "organizations:transferOrganizationOwnership" as any,
  );
  const removeMember = useMutation("organizations:removeMember" as any);
  const generateLogoUploadUrl = useAction(
    "organizations:generateOrganizationLogoUploadUrl" as any,
  );
  const updateOrganizationLogo = useMutation(
    "organizations:updateOrganizationLogo" as any,
  );

  return {
    createOrganization,
    updateOrganization,
    deleteOrganization,
    addMember,
    changeMemberRole,
    transferOrganizationOwnership,
    removeMember,
    generateLogoUploadUrl,
    updateOrganizationLogo,
  };
}
