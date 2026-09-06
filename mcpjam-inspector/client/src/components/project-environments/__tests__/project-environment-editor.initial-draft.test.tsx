/**
 * ProjectEnvironmentEditor — `initialDraft` (the Connect capture seed).
 *
 * Create-mode-only: the seed populates the initializer (making the form dirty
 * and immediately creatable), and is IGNORED in edit mode — an edit form's
 * draft always comes from the row.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateEnvironment, mockUpdateEnvironment } = vi.hoisted(() => ({
  mockCreateEnvironment: vi.fn(),
  mockUpdateEnvironment: vi.fn(),
}));

vi.mock("@/hooks/useProjectEnvironments", () => ({
  useCreateProjectEnvironment: () => mockCreateEnvironment,
  useUpdateProjectEnvironment: () => mockUpdateEnvironment,
  isRevisionConflictError: () => false,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => false,
}));
vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => true,
}));
vi.mock("@/hooks/useSandboxImages", () => ({
  useSandboxImages: () => undefined,
}));
vi.mock("@/components/hosts/HostPicker", () => ({
  HostPicker: ({ value }: { value: string | null }) => (
    <div data-testid="host-picker">{value ?? "none"}</div>
  ),
}));
vi.mock("@/components/hosts/server-picker", () => ({
  ServerPicker: () => <div />,
}));
vi.mock("../ProjectEnvironmentSkillsPicker", () => ({
  ProjectEnvironmentSkillsPicker: () => <div />,
}));
// The secrets picker is a sibling section, not what these tests are about. It
// is stubbed rather than mocked at the hook level because it reads a live
// Convex query, and a real one here would need the whole provider.
vi.mock("../ProjectEnvironmentSecretsPicker", () => ({
  ProjectEnvironmentSecretsPicker: () => <div />,
}));
vi.mock("@/components/computer/EnvironmentBuildBadge", () => ({
  EnvironmentBuildBadge: () => null,
}));
vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/lib/convex-error", () => ({
  convexErrMessage: (_e: unknown, fallback: string) => fallback,
}));

import { ProjectEnvironmentEditor } from "../ProjectEnvironmentEditor";

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateEnvironment.mockResolvedValue({
    environmentId: "env_new",
    projectId: "proj_1",
    name: "Claude Code",
    hostId: "host_1",
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
  });
});

describe("ProjectEnvironmentEditor — initialDraft", () => {
  it("seeds the create form and the seeded draft is immediately creatable", async () => {
    render(
      <ProjectEnvironmentEditor
        projectId="proj_1"
        environment={null}
        canManage
        initialDraft={{ name: "Claude Code", hostId: "host_1" }}
      />,
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Claude Code");
    expect(screen.getByTestId("host-picker")).toHaveTextContent("host_1");

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockCreateEnvironment).toHaveBeenCalled());
    expect(mockCreateEnvironment.mock.calls[0]![0]).toMatchObject({
      projectId: "proj_1",
      name: "Claude Code",
      hostId: "host_1",
    });
  });

  it("is ignored in edit mode — the row wins", () => {
    render(
      <ProjectEnvironmentEditor
        projectId="proj_1"
        environment={{
          environmentId: "env_1",
          projectId: "proj_1",
          name: "Existing",
          hostId: "host_row",
          revision: 2,
          createdAt: 0,
          updatedAt: 0,
        }}
        canManage
        initialDraft={{ name: "Seeded", hostId: "host_seed" }}
      />,
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Existing");
    expect(screen.getByTestId("host-picker")).toHaveTextContent("host_row");
  });
});
