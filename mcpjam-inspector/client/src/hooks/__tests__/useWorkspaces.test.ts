import { describe, expect, it } from "vitest";
import {
  filterWorkspacesForOrganization,
  type RemoteWorkspace,
} from "../useWorkspaces";

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
