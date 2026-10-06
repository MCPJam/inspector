/**
 * ProjectEnvironmentEditor — `initialDraft` (the Connect capture seed).
 *
 * Create-mode-only: the seed populates the initializer (making the form dirty
 * and immediately creatable), and is IGNORED in edit mode — an edit form's
 * draft always comes from the row.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateEnvironment, mockUpdateEnvironment, flags } = vi.hoisted(
  () => ({
    mockCreateEnvironment: vi.fn(),
    mockUpdateEnvironment: vi.fn(),
    flags: { plugins: true },
  }),
);

vi.mock("@/hooks/useProjectEnvironments", () => ({
  useCreateProjectEnvironment: () => mockCreateEnvironment,
  useUpdateProjectEnvironment: () => mockUpdateEnvironment,
  isRevisionConflictError: () => false,
}));
vi.mock("@/hooks/usePluginsEnabled", () => ({
  usePluginsEnabled: () => flags.plugins,
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
  ServerPicker: ({
    offerClear,
    onClearSelection,
  }: {
    offerClear?: boolean;
    onClearSelection?: () => void;
  }) => (
    <div
      data-testid="server-picker"
      data-offer-clear={String(offerClear ?? true)}
      data-can-clear={String(Boolean(onClearSelection))}
    />
  ),
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

vi.mock("../ProjectEnvironmentPluginsPicker", () => ({
  ProjectEnvironmentPluginsPicker: ({
    onChange,
  }: {
    onChange: (v: string[]) => void;
  }) => (
    <button onClick={() => onChange(["version_exact"])}>
      Pick imported plugin
    </button>
  ),
}));

import { ProjectEnvironmentEditor } from "../ProjectEnvironmentEditor";

beforeEach(() => {
  vi.clearAllMocks();
  flags.plugins = true;
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

describe("immutable plugin pins in existing environment editor", () => {
  it("creates with the explicitly selected immutable version", async () => {
    render(
      <ProjectEnvironmentEditor
        projectId="proj_1"
        environment={null}
        canManage
        initialDraft={{ name: "Disposable", hostId: "host_1" }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Pick imported plugin" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockCreateEnvironment).toHaveBeenCalled());
    expect(mockCreateEnvironment.mock.calls[0][0].pluginVersionIds).toEqual([
      "version_exact",
    ]);
  });
  it("omits the pin if rollout closes after selection", async () => {
    const props = {
      projectId: "proj_1",
      environment: null,
      canManage: true,
      initialDraft: { name: "Disposable", hostId: "host_1" },
    };
    const view = render(<ProjectEnvironmentEditor {...props} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Pick imported plugin" }),
    );
    flags.plugins = false;
    view.rerender(<ProjectEnvironmentEditor {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockCreateEnvironment).toHaveBeenCalled());
    expect(mockCreateEnvironment.mock.calls[0][0]).not.toHaveProperty(
      "pluginVersionIds",
    );
  });
});
