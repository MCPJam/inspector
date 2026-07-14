import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/state/app-types";

const { authState, membersState } = vi.hoisted(() => ({
  authState: { isAuthenticated: true },
  membersState: {
    activeMembers: [] as Array<{
      email: string;
      role?: string;
      projectRole?: string;
    }>,
    pendingMembers: [] as unknown[],
    members: [] as unknown[],
    canManageMembers: true,
    isLoading: false,
    hasPendingMembers: false,
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: authState.isAuthenticated,
    isLoading: false,
  }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { email: "admin@example.com" } }),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: () => membersState,
}));

// Heavy child sections are irrelevant to the XAA-defaults behavior under
// test — stub them to keep the render focused and dependency-free.
vi.mock("../setting/AccountApiKeySection", () => ({
  AccountApiKeySection: () => <div data-testid="api-key-section" />,
}));
vi.mock("../setting/ProjectSlackIntegrationSection", () => ({
  ProjectSlackIntegrationSection: () => <div data-testid="slack-section" />,
}));
vi.mock("../project/ProjectMembersFacepile", () => ({
  ProjectMembersFacepile: () => <div data-testid="facepile" />,
}));
vi.mock("../project/ProjectShareButton", () => ({
  ProjectShareButton: () => <div data-testid="share-button" />,
}));
vi.mock("../project/ProjectEmojiPicker", () => ({
  ProjectIconPicker: () => <div data-testid="icon-picker" />,
}));
vi.mock("../ui/editable-text", () => ({
  EditableText: ({ value }: { value: string }) => <span>{value}</span>,
}));

import { ProjectSettingsTab } from "../ProjectSettingsTab";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-local-1",
    name: "Demo project",
    servers: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    sharedProjectId: "proj-remote-1",
    organizationId: "org-1",
    ...overrides,
  };
}

function renderTab(props?: {
  project?: Project;
  convexProjectId?: string | null;
  onUpdateProject?: ReturnType<typeof vi.fn>;
}) {
  const onUpdateProject = props?.onUpdateProject ?? vi.fn(async () => {});
  render(
    <ProjectSettingsTab
      activeProjectId="proj-local-1"
      project={props?.project ?? makeProject()}
      convexProjectId={
        props?.convexProjectId === undefined
          ? "proj-remote-1"
          : props.convexProjectId
      }
      projectServers={{}}
      onUpdateProject={onUpdateProject}
      onDeleteProject={vi.fn(async () => true)}
      onProjectShared={vi.fn()}
      onNavigateAway={vi.fn()}
    />,
  );
  return { onUpdateProject };
}

describe("ProjectSettingsTab — XAA test identity defaults", () => {
  beforeEach(() => {
    authState.isAuthenticated = true;
    membersState.canManageMembers = true;
    membersState.activeMembers = [
      { email: "admin@example.com", role: "admin", projectRole: "admin" },
    ];
  });

  it("saves an atomic identity pair through onUpdateProject", async () => {
    const user = userEvent.setup();
    const { onUpdateProject } = renderTab();

    expect(
      screen.getByText("XAA test identity defaults"),
    ).toBeInTheDocument();
    // Fixed issuer — the MCPJam test IdP, never enterprise SSO.
    expect(
      screen.getByText(/Identity provider: MCPJam test IdP/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Used when an authenticated project member connects without a server override/,
      ),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Subject (sub)"), " proj-sub-1 ");
    await user.type(screen.getByLabelText("Email"), " proj@example.com ");
    await user.click(screen.getByRole("button", { name: "Save defaults" }));

    expect(onUpdateProject).toHaveBeenCalledWith("proj-local-1", {
      xaaTestDefaults: {
        defaultIdentity: {
          subject: "proj-sub-1",
          email: "proj@example.com",
        },
      },
    });
  });

  it("sends an explicit null to clear a stored default", async () => {
    const user = userEvent.setup();
    const { onUpdateProject } = renderTab({
      project: makeProject({
        xaaTestDefaults: {
          defaultIdentity: {
            subject: "proj-sub-1",
            email: "proj@example.com",
          },
        },
      }),
    });

    expect(screen.getByLabelText("Subject (sub)")).toHaveValue("proj-sub-1");
    expect(screen.getByLabelText("Email")).toHaveValue("proj@example.com");

    await user.clear(screen.getByLabelText("Subject (sub)"));
    await user.clear(screen.getByLabelText("Email"));
    await user.click(screen.getByRole("button", { name: "Save defaults" }));

    expect(onUpdateProject).toHaveBeenCalledWith("proj-local-1", {
      xaaTestDefaults: null,
    });
  });

  it("blocks a partial pair with inline validation and no save call", async () => {
    const user = userEvent.setup();
    const { onUpdateProject } = renderTab();

    await user.type(screen.getByLabelText("Subject (sub)"), "proj-sub-1");
    await user.click(screen.getByRole("button", { name: "Save defaults" }));

    expect(onUpdateProject).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /both a subject and an email, or clear both/i,
    );
  });

  it("gates editing on project admin rights", () => {
    membersState.canManageMembers = false;
    renderTab();

    expect(screen.getByLabelText("Subject (sub)")).toBeDisabled();
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save defaults" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Only project admins can change these defaults/),
    ).toBeInTheDocument();
  });

  it("is hidden for a local-only (non-Convex) project", () => {
    renderTab({ convexProjectId: null });
    expect(
      screen.queryByText("XAA test identity defaults"),
    ).not.toBeInTheDocument();
  });

  it("documents the demo-identity fallback without claiming the signed-in user", () => {
    renderTab();
    expect(
      screen.getByText(/Falls back to MCPJam's demo identity/),
    ).toBeInTheDocument();
    // The empty state must never claim the signed-in user's identity is used.
    expect(screen.queryByText(/signed-in/i)).not.toBeInTheDocument();
    // And the section explains it is not enterprise SSO / BYO IdP config.
    expect(
      screen.getByText(
        /does not configure enterprise SSO or bring-your-own IdP endpoints/,
      ),
    ).toBeInTheDocument();
  });
});
