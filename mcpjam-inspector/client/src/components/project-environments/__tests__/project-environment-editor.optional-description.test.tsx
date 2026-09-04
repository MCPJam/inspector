/**
 * ProjectEnvironmentEditor — Description really is optional (SUTB-4).
 *
 * The field is labelled "(optional)" in its placeholder, so the form must
 * never treat it as required: an empty description carries no invalid state,
 * blocks neither Create nor Save, and is OMITTED from the create payload
 * rather than sent as "".
 *
 * These are regression pins, not a fix: SUTB-4 reported a red-outlined
 * description and a dead Save button, and neither behaviour exists here. The
 * only thing that greys Save in edit mode is the not-dirty rule, which these
 * tests separate from the description explicitly — a future "required
 * description" would have to break one of them.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateEnvironment, mockUpdateEnvironment, mockToast } = vi.hoisted(
  () => ({
    mockCreateEnvironment: vi.fn(),
    mockUpdateEnvironment: vi.fn(),
    mockToast: { error: vi.fn(), success: vi.fn() },
  }),
);

vi.mock("@/hooks/useProjectEnvironments", () => ({
  useCreateProjectEnvironment: () => mockCreateEnvironment,
  useUpdateProjectEnvironment: () => mockUpdateEnvironment,
  isRevisionConflictError: () => false,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => false,
}));
vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => false,
}));
vi.mock("@/hooks/useSandboxImages", () => ({
  useSandboxImages: () => undefined,
}));
vi.mock("@/components/hosts/HostPicker", () => ({
  HostPicker: ({ value }: { value: string | null }) => (
    <div data-testid="host-picker">{value ?? "none"}</div>
  ),
}));
vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: () => <div />,
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
vi.mock("@/lib/toast", () => ({ toast: mockToast }));
vi.mock("@/lib/convex-error", () => ({
  convexErrMessage: (_e: unknown, fallback: string) => fallback,
}));

import { ProjectEnvironmentEditor } from "../ProjectEnvironmentEditor";

/** A named row with NO description — what a create without one produces. */
const rowWithoutDescription = {
  environmentId: "env_1",
  projectId: "proj_1",
  name: "test environment",
  hostId: "host_1",
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateEnvironment.mockResolvedValue({
    ...rowWithoutDescription,
    environmentId: "env_new",
  });
  mockUpdateEnvironment.mockResolvedValue({
    ...rowWithoutDescription,
    name: "renamed",
    revision: 2,
  });
});

describe("ProjectEnvironmentEditor — optional description", () => {
  it("creates with an empty description, omitting the field from the payload", async () => {
    render(
      <ProjectEnvironmentEditor
        projectId="proj_1"
        environment={null}
        canManage
        initialDraft={{ name: "test environment", hostId: "host_1" }}
      />,
    );

    const description = screen.getByLabelText("Description");
    expect(description).toHaveValue("");
    // No validation surface on the field: nothing to paint it red, nothing
    // for the browser to block a submit on.
    expect(description).not.toBeRequired();
    expect(description).not.toHaveAttribute("aria-invalid");

    const create = screen.getByRole("button", { name: "Create" });
    expect(create).toBeEnabled();
    fireEvent.click(create);

    await waitFor(() => expect(mockCreateEnvironment).toHaveBeenCalled());
    const payload = mockCreateEnvironment.mock.calls[0]![0];
    expect(payload).toMatchObject({ name: "test environment" });
    expect(payload).not.toHaveProperty("description");
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("saves an existing row whose description stays empty — only dirtiness gates Save", async () => {
    render(
      <ProjectEnvironmentEditor
        projectId="proj_1"
        environment={rowWithoutDescription}
        canManage
      />,
    );

    // Grey at rest because the draft matches the row, NOT because the
    // description is empty — this is the button state SUTB-4 misread.
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    // One edit elsewhere is enough to save, with the description still empty.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "renamed" },
    });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(mockUpdateEnvironment).toHaveBeenCalled());
    const patch = mockUpdateEnvironment.mock.calls[0]![0];
    expect(patch).toMatchObject({ environmentId: "env_1", name: "renamed" });
    // Unchanged (still empty) ⇒ omitted, per the tri-state update contract.
    expect(patch).not.toHaveProperty("description");
    expect(mockToast.error).not.toHaveBeenCalled();
  });
});
