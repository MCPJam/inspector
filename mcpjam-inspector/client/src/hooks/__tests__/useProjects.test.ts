import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterProjectsForOrganization,
  normalizeProjectMembersResult,
  type RemoteProject,
  useProjectQueries,
  type ProjectMember,
} from "../useProjects";

const { mockUseMutation, mockUseQuery } = vi.hoisted(() => ({
  mockUseMutation: vi.fn(),
  mockUseQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: mockUseMutation,
  useQuery: mockUseQuery,
}));

function createProject(
  id: string,
  overrides: Partial<RemoteProject> = {},
): RemoteProject {
  return {
    _id: id,
    name: `Project ${id}`,
    servers: {},
    organizationId: "org-1",
    ownerId: "user-1",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("filterProjectsForOrganization", () => {
  it("returns all projects when no organization filter is set", () => {
    const projects = [
      createProject("ws-1", { organizationId: "org-1" }),
      createProject("ws-2", { organizationId: "org-2" }),
    ];

    expect(filterProjectsForOrganization(projects)).toEqual(projects);
  });

  it("filters by organization", () => {
    const projects = [
      createProject("ws-1", { organizationId: "org-1" }),
      createProject("ws-2", { organizationId: "org-2" }),
      createProject("ws-3", { organizationId: "org-1" }),
    ];

    expect(filterProjectsForOrganization(projects, "org-1")).toEqual([
      projects[0],
      projects[2],
    ]);
  });
});

describe("useProjectQueries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue(vi.fn());
  });

  it("preserves undefined projects while the authenticated query is loading", () => {
    mockUseQuery.mockReturnValue(undefined);

    const { result } = renderHook(() =>
      useProjectQueries({
        isAuthenticated: true,
        organizationId: "org-1",
      }),
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.allProjects).toBeUndefined();
    expect(result.current.projects).toBeUndefined();
    expect(result.current.sortedProjects).toEqual([]);
    expect(result.current.hasProjects).toBe(false);
    expect(result.current.hasAnyProjects).toBe(false);
    expect(mockUseQuery).toHaveBeenCalledWith("projects:getMyProjects", {});
  });
});

describe("normalizeProjectMembersResult", () => {
  it("supports the current object-shaped backend response", () => {
    const member: ProjectMember = {
      _id: "member-1",
      projectId: "ws-1",
      email: "person@example.com",
      addedBy: "user-1",
      addedAt: 1,
      isOwner: false,
      isPending: false,
      hasAccess: true,
      accessSource: "project",
      canRemove: true,
      user: null,
    };

    expect(
      normalizeProjectMembersResult({
        members: [member],
        canManageMembers: true,
      }),
    ).toEqual({
      members: [member],
      canManageMembers: true,
    });
  });

  it("falls back safely for unexpected query values", () => {
    expect(
      normalizeProjectMembersResult("billing_limit_reached" as never),
    ).toEqual({
      members: [],
      canManageMembers: false,
    });
  });
});
