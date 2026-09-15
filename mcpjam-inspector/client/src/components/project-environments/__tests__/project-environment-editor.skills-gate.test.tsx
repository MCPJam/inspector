/**
 * ProjectEnvironmentEditor — the "Skills" section behind `skills-enabled`.
 *
 * Environments can launch before hosted Cloud Skills, so the skills section
 * mirrors the sandbox-image fail-closed contract: flag off ⇒ the picker never
 * renders, AND a save of an environment that already carries a
 * `skillSelection` (set via API/CLI) must OMIT the field from the update
 * payload entirely — sending `null` would silently clear the pins. Also
 * covers the flag flipping false AFTER an edit (the diverged draft value must
 * not ship) and the flag-on attach/clear wire shapes.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateEnvironment, mockUpdateEnvironment, mockSkillsEnabled } =
  vi.hoisted(() => ({
    mockCreateEnvironment: vi.fn(),
    mockUpdateEnvironment: vi.fn(),
    mockSkillsEnabled: { value: true },
  }));

vi.mock("@/hooks/useProjectEnvironments", () => ({
  useCreateProjectEnvironment: () => mockCreateEnvironment,
  useUpdateProjectEnvironment: () => mockUpdateEnvironment,
  isRevisionConflictError: () => false,
}));
vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => mockSkillsEnabled.value,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => false,
}));
vi.mock("@/hooks/useSandboxImages", () => ({
  useSandboxImages: () => undefined,
}));
// Sibling sections are not under test — render inert placeholders. The skills
// picker mock exposes attach/clear buttons so tests can drive `onChange`.
vi.mock("@/components/hosts/HostPicker", () => ({
  HostPicker: ({ onChange }: { onChange: (hostId: string | null) => void }) => (
    <button type="button" onClick={() => onChange("host-1")}>
      pick-host
    </button>
  ),
}));
vi.mock("@/components/hosts/server-picker", () => ({
  ServerPicker: () => <div data-testid="server-group-picker" />,
}));
vi.mock("../ProjectEnvironmentSkillsPicker", () => ({
  ProjectEnvironmentSkillsPicker: ({
    onChange,
  }: {
    onChange: (next: { mode: "explicit"; skillIds: string[] } | null) => void;
  }) => (
    <div data-testid="skills-picker">
      <button
        type="button"
        onClick={() => onChange({ mode: "explicit", skillIds: ["sk-1"] })}
      >
        pick-skill
      </button>
      <button type="button" onClick={() => onChange(null)}>
        clear-skills
      </button>
    </div>
  ),
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
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

const PINNED = { mode: "explicit" as const, skillIds: ["sk-1", "sk-2"] };

function envRow(
  overrides: Partial<ProjectEnvironmentView> = {},
): ProjectEnvironmentView {
  return {
    environmentId: "env-1",
    projectId: "proj-1",
    name: "Staging",
    hostId: "host-1",
    revision: 3,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSkillsEnabled.value = true;
  mockCreateEnvironment.mockResolvedValue(envRow({ name: "created" }));
  mockUpdateEnvironment.mockResolvedValue(envRow({ revision: 4 }));
});

function renderEditor(environment: ProjectEnvironmentView | null) {
  return render(
    <ProjectEnvironmentEditor
      projectId="proj-1"
      environment={environment}
      canManage
    />,
  );
}

describe("flag gating + the omission contract", () => {
  it("hides the skills section when skills-enabled is off", () => {
    mockSkillsEnabled.value = false;
    renderEditor(envRow());
    expect(screen.queryByTestId("skills-picker")).not.toBeInTheDocument();
    expect(screen.queryByText("Skills")).not.toBeInTheDocument();
  });

  it("flag-off save of a pinned env OMITS skillSelection (pins survive)", async () => {
    mockSkillsEnabled.value = false;
    renderEditor(envRow({ skillSelection: PINNED }));

    // Name-only edit, then save.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateEnvironment).toHaveBeenCalled());
    const args = mockUpdateEnvironment.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(args.name).toBe("Renamed");
    // Omitted entirely — not null, not the old value.
    expect("skillSelection" in args).toBe(false);
  });

  it("flag-on untouched selection is also omitted on an unrelated edit", async () => {
    renderEditor(envRow({ skillSelection: PINNED }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdateEnvironment).toHaveBeenCalled());
    expect(
      "skillSelection" in
        (mockUpdateEnvironment.mock.calls[0]![0] as Record<string, unknown>),
    ).toBe(false);
  });
});

describe("flag flips false AFTER an edit", () => {
  it("omits the selection when the flag turns off between editing and saving", async () => {
    const { rerender } = renderEditor(envRow({ skillSelection: PINNED }));
    // Admin clears the pins while the picker is visible…
    fireEvent.click(screen.getByRole("button", { name: "clear-skills" }));
    // …then PostHog re-evaluates the flag to false and the picker unmounts.
    mockSkillsEnabled.value = false;
    rerender(
      <ProjectEnvironmentEditor
        projectId="proj-1"
        environment={envRow({ skillSelection: PINNED })}
        canManage
      />,
    );
    expect(screen.queryByTestId("skills-picker")).not.toBeInTheDocument();

    // The diverged draft value must NOT ship: a hidden picker always omits.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdateEnvironment).toHaveBeenCalled());
    const args = mockUpdateEnvironment.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(args.name).toBe("Renamed");
    expect("skillSelection" in args).toBe(false);
  });

  it("create also omits picked skills once the flag turns off", async () => {
    const { rerender } = renderEditor(null);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "New env" },
    });
    fireEvent.click(screen.getByRole("button", { name: "pick-host" }));
    fireEvent.click(screen.getByRole("button", { name: "pick-skill" }));

    mockSkillsEnabled.value = false;
    rerender(
      <ProjectEnvironmentEditor
        projectId="proj-1"
        environment={null}
        canManage
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockCreateEnvironment).toHaveBeenCalled());
    expect(
      "skillSelection" in
        (mockCreateEnvironment.mock.calls[0]![0] as Record<string, unknown>),
    ).toBe(false);
  });
});

describe("wire shapes (flag on)", () => {
  it("attach sends the selection on update", async () => {
    renderEditor(envRow());
    fireEvent.click(screen.getByRole("button", { name: "pick-skill" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdateEnvironment).toHaveBeenCalled());
    expect(mockUpdateEnvironment.mock.calls[0]![0]).toMatchObject({
      expectedRevision: 3,
      skillSelection: { mode: "explicit", skillIds: ["sk-1"] },
    });
  });

  it("clear sends null on update", async () => {
    renderEditor(envRow({ skillSelection: PINNED }));
    fireEvent.click(screen.getByRole("button", { name: "clear-skills" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdateEnvironment).toHaveBeenCalled());
    expect(
      (mockUpdateEnvironment.mock.calls[0]![0] as Record<string, unknown>)
        .skillSelection,
    ).toBeNull();
  });

  it("create includes the selection only when picked", async () => {
    renderEditor(null);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "New env" },
    });
    fireEvent.click(screen.getByRole("button", { name: "pick-host" }));
    fireEvent.click(screen.getByRole("button", { name: "pick-skill" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockCreateEnvironment).toHaveBeenCalled());
    expect(mockCreateEnvironment.mock.calls[0]![0]).toMatchObject({
      projectId: "proj-1",
      hostId: "host-1",
      skillSelection: { mode: "explicit", skillIds: ["sk-1"] },
    });
  });
});
