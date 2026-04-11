import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/state/app-types";
import { WorkspaceSettingsTab } from "../WorkspaceSettingsTab";

const mockWorkspaceMembersFacepile = vi.fn(() => <div />);
const mockWorkspaceShareButton = vi.fn(() => <div />);

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
  }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: {
      email: "owner@example.com",
      firstName: "Owner",
      lastName: "Example",
    },
  }),
}));

vi.mock("@/hooks/useWorkspaces", () => ({
  useWorkspaceMembers: () => ({
    activeMembers: [],
    canManageMembers: true,
  }),
}));

vi.mock("../workspace/WorkspaceMembersFacepile", () => ({
  WorkspaceMembersFacepile: (props: unknown) =>
    mockWorkspaceMembersFacepile(props),
}));

vi.mock("../workspace/WorkspaceShareButton", () => ({
  WorkspaceShareButton: (props: unknown) => mockWorkspaceShareButton(props),
}));

vi.mock("../workspace/WorkspaceEmojiPicker", () => ({
  WorkspaceIconPicker: () => <div />,
}));

vi.mock("../ui/editable-text", () => ({
  EditableText: () => <div />,
}));

vi.mock("../setting/AccountApiKeySection", () => ({
  AccountApiKeySection: () => <div />,
}));

vi.mock("../setting/WorkspaceSlackIntegrationSection", () => ({
  WorkspaceSlackIntegrationSection: () => <div />,
}));

function createWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    name: "Acme",
    servers: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("WorkspaceSettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the selected org to share controls when the workspace org is missing", () => {
    render(
      <WorkspaceSettingsTab
        activeWorkspaceId="ws-1"
        workspace={createWorkspace()}
        convexWorkspaceId={null}
        workspaceServers={{}}
        activeOrganizationId="org-active"
        onUpdateWorkspace={vi.fn().mockResolvedValue(undefined)}
        onDeleteWorkspace={vi.fn().mockResolvedValue(true)}
        onWorkspaceShared={vi.fn()}
        onNavigateAway={vi.fn()}
      />,
    );

    expect(mockWorkspaceMembersFacepile).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-active",
      }),
    );
    expect(mockWorkspaceShareButton).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-active",
      }),
    );
  });

  it("prefers the workspace org over the selected org for share controls", () => {
    render(
      <WorkspaceSettingsTab
        activeWorkspaceId="ws-1"
        workspace={createWorkspace({ organizationId: "org-workspace" })}
        convexWorkspaceId={null}
        workspaceServers={{}}
        activeOrganizationId="org-active"
        onUpdateWorkspace={vi.fn().mockResolvedValue(undefined)}
        onDeleteWorkspace={vi.fn().mockResolvedValue(true)}
        onWorkspaceShared={vi.fn()}
        onNavigateAway={vi.fn()}
      />,
    );

    expect(mockWorkspaceMembersFacepile).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-workspace",
      }),
    );
    expect(mockWorkspaceShareButton).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-workspace",
      }),
    );
  });
});
