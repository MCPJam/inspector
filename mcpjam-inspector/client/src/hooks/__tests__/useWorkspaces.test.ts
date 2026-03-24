import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterWorkspacesForOrganization,
  type RemoteWorkspace,
  useWorkspaceQueries,
} from "../useWorkspaces";

const { mockUseMutation, mockUseQuery } = vi.hoisted(() => ({
  mockUseMutation: vi.fn(),
  mockUseQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: mockUseMutation,
  useQuery: mockUseQuery,
}));

function createWorkspace(
  id: string,
  overrides: Partial<RemoteWorkspace> = {},
): RemoteWorkspace {
  return {
    _id: id,
    name: `Workspace ${id}`,
    servers: {},
    ownerId: "user-1",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("filterWorkspacesForOrganization", () => {
  it("returns all workspaces when no organization filter is set", () => {
    const workspaces = [
      createWorkspace("ws-1", { organizationId: "org-1" }),
      createWorkspace("ws-2", { organizationId: "org-2" }),
    ];

    expect(filterWorkspacesForOrganization(workspaces)).toEqual(workspaces);
  });

  it("keeps legacy unscoped results while any workspace is missing organizationId", () => {
    const workspaces = [
      createWorkspace("ws-1", { organizationId: "org-1" }),
      createWorkspace("ws-2"),
    ];

    expect(filterWorkspacesForOrganization(workspaces, "org-1")).toEqual(
      workspaces,
    );
  });

  it("filters by organization once all workspaces are org-scoped", () => {
    const workspaces = [
      createWorkspace("ws-1", { organizationId: "org-1" }),
      createWorkspace("ws-2", { organizationId: "org-2" }),
      createWorkspace("ws-3", { organizationId: "org-1" }),
    ];

    expect(filterWorkspacesForOrganization(workspaces, "org-1")).toEqual([
      workspaces[0],
      workspaces[2],
    ]);
  });
});

describe("useWorkspaceQueries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue(vi.fn());
  });

  it("preserves undefined workspaces while the authenticated query is loading", () => {
    mockUseQuery.mockReturnValue(undefined);

    const { result } = renderHook(() =>
      useWorkspaceQueries({
        isAuthenticated: true,
        organizationId: "org-1",
      }),
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.allWorkspaces).toBeUndefined();
    expect(result.current.workspaces).toBeUndefined();
    expect(result.current.sortedWorkspaces).toEqual([]);
    expect(result.current.hasWorkspaces).toBe(false);
    expect(result.current.hasAnyWorkspaces).toBe(false);
    expect(mockUseQuery).toHaveBeenCalledWith("workspaces:getMyWorkspaces", {});
  });
});
