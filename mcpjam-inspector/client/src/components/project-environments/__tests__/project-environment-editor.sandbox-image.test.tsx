/**
 * ProjectEnvironmentEditor — the "Sandbox image" section.
 *
 * The load-bearing case is the OMISSION contract: when the `computers-enabled`
 * flag is off the picker never renders, so a save of an environment that
 * already carries a pin (set via API/CLI) must OMIT `computerEnvironmentId`
 * from the update payload entirely — sending `null` would silently clear it.
 * The rest covers the attach/clear wire shapes, create-mode inclusion, and the
 * option-list states (not-built suffix, personal drafts disabled, deleted pin
 * kept visible instead of coerced to "None").
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateEnvironment,
  mockUpdateEnvironment,
  mockComputersEnabled,
  mockSandboxImages,
} = vi.hoisted(() => ({
  mockCreateEnvironment: vi.fn(),
  mockUpdateEnvironment: vi.fn(),
  mockComputersEnabled: { value: true },
  mockSandboxImages: { value: [] as unknown[] | undefined },
}));

vi.mock("@/hooks/useProjectEnvironments", () => ({
  useCreateProjectEnvironment: () => mockCreateEnvironment,
  useUpdateProjectEnvironment: () => mockUpdateEnvironment,
  isRevisionConflictError: () => false,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => mockComputersEnabled.value,
}));
vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => true,
}));
vi.mock("@/hooks/useSandboxImages", () => ({
  useSandboxImages: (projectId: string | null) =>
    projectId ? mockSandboxImages.value : undefined,
}));
// Sibling sections are not under test — render inert placeholders.
vi.mock("@/components/hosts/HostPicker", () => ({
  HostPicker: ({
    onChange,
  }: {
    onChange: (hostId: string | null) => void;
  }) => (
    <button type="button" onClick={() => onChange("host-1")}>
      pick-host
    </button>
  ),
}));
vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: () => <div data-testid="server-group-picker" />,
}));
vi.mock("../ProjectEnvironmentSkillsPicker", () => ({
  ProjectEnvironmentSkillsPicker: () => <div data-testid="skills-picker" />,
}));
vi.mock("@/components/computer/EnvironmentBuildBadge", () => ({
  EnvironmentBuildBadge: ({ build }: { build: unknown }) => (
    <span data-testid="build-badge">{build ? "has-build" : "no-build"}</span>
  ),
}));
vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/lib/convex-error", () => ({
  convexErrMessage: (_e: unknown, fallback: string) => fallback,
}));

import { ProjectEnvironmentEditor } from "../ProjectEnvironmentEditor";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

const IMAGE_READY = {
  environmentId: "img-ready",
  projectId: "proj-1",
  name: "Node 20",
  blueprint: "",
  contentHash: "h1",
  sharing: "project",
  isOwner: false,
  currentBuild: { buildId: "b1", status: "ready", provider: "e2b" },
  createdAt: 0,
  updatedAt: 0,
};
const IMAGE_UNBUILT = {
  ...IMAGE_READY,
  environmentId: "img-unbuilt",
  name: "Py 3.12",
  currentBuild: null,
};
const IMAGE_DRAFT = {
  ...IMAGE_READY,
  environmentId: "img-draft",
  name: "My draft",
  sharing: "user",
  isOwner: true,
};

function envRow(
  overrides: Partial<ProjectEnvironmentView> = {}
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
  mockComputersEnabled.value = true;
  mockSandboxImages.value = [IMAGE_READY, IMAGE_UNBUILT, IMAGE_DRAFT];
  mockCreateEnvironment.mockResolvedValue(envRow({ name: "created" }));
  mockUpdateEnvironment.mockResolvedValue(envRow({ revision: 4 }));
});

function renderEditor(environment: ProjectEnvironmentView | null) {
  return render(
    <ProjectEnvironmentEditor
      projectId="proj-1"
      environment={environment}
      canManage
    />
  );
}

const select = () =>
  screen.getByTestId(
    "project-environment-sandbox-image"
  ) as HTMLSelectElement;

describe("flag gating + the omission contract", () => {
  it("hides the picker when computers-enabled is off", () => {
    mockComputersEnabled.value = false;
    renderEditor(envRow());
    expect(
      screen.queryByTestId("project-environment-sandbox-image")
    ).not.toBeInTheDocument();
  });

  it("flag-off save of a pinned env OMITS computerEnvironmentId (pin survives)", async () => {
    mockComputersEnabled.value = false;
    renderEditor(envRow({ computerEnvironmentId: "img-ready" }));

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
    expect("computerEnvironmentId" in args).toBe(false);
  });

  it("flag-on untouched pin is also omitted on an unrelated edit", async () => {
    renderEditor(envRow({ computerEnvironmentId: "img-ready" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdateEnvironment).toHaveBeenCalled());
    expect(
      "computerEnvironmentId" in
        (mockUpdateEnvironment.mock.calls[0]![0] as Record<string, unknown>)
    ).toBe(false);
  });
});

describe("flag flips false AFTER an edit (review regression)", () => {
  it("omits the pin when the flag turns off between editing and saving", async () => {
    const { rerender } = renderEditor(envRow({ computerEnvironmentId: "img-ready" }));
    // Admin clears the pin while the picker is visible…
    fireEvent.change(select(), { target: { value: "" } });
    // …then PostHog re-evaluates the flag to false and the picker unmounts.
    mockComputersEnabled.value = false;
    rerender(
      <ProjectEnvironmentEditor
        projectId="proj-1"
        environment={envRow({ computerEnvironmentId: "img-ready" })}
        canManage
      />
    );
    expect(
      screen.queryByTestId("project-environment-sandbox-image")
    ).not.toBeInTheDocument();

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
    expect("computerEnvironmentId" in args).toBe(false);
  });

  it("create also omits a picked image once the flag turns off", async () => {
    const { rerender } = renderEditor(null);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "New env" },
    });
    fireEvent.click(screen.getByRole("button", { name: "pick-host" }));
    fireEvent.change(select(), { target: { value: "img-ready" } });

    mockComputersEnabled.value = false;
    rerender(
      <ProjectEnvironmentEditor
        projectId="proj-1"
        environment={null}
        canManage
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockCreateEnvironment).toHaveBeenCalled());
    expect(
      "computerEnvironmentId" in
        (mockCreateEnvironment.mock.calls[0]![0] as Record<string, unknown>)
    ).toBe(false);
  });
});

describe("loading state (review regression)", () => {
  it("does not flash 'Unknown image' while the image list is still loading", () => {
    mockSandboxImages.value = undefined;
    renderEditor(envRow({ computerEnvironmentId: "img-ready" }));
    expect(
      Array.from(select().options).some((o) =>
        o.text.startsWith("Unknown image")
      )
    ).toBe(false);
    // …and the pin still reads as selected rather than collapsing to "None"
    // (a <select> whose value matches no option renders as the first option,
    // which would make a pinned environment look unpinned mid-load).
    expect(select().value).toBe("img-ready");
    expect(
      Array.from(select().options).some((o) => o.text === "Loading image…")
    ).toBe(true);
  });
});

describe("wire shapes", () => {
  it("attach sends the id on update", async () => {
    renderEditor(envRow());
    fireEvent.change(select(), { target: { value: "img-ready" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdateEnvironment).toHaveBeenCalled());
    expect(mockUpdateEnvironment.mock.calls[0]![0]).toMatchObject({
      expectedRevision: 3,
      computerEnvironmentId: "img-ready",
    });
  });

  it("clear sends null on update", async () => {
    renderEditor(envRow({ computerEnvironmentId: "img-ready" }));
    fireEvent.change(select(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdateEnvironment).toHaveBeenCalled());
    expect(
      (mockUpdateEnvironment.mock.calls[0]![0] as Record<string, unknown>)
        .computerEnvironmentId
    ).toBeNull();
  });

  it("create includes the id only when selected", async () => {
    renderEditor(null);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "New env" },
    });
    fireEvent.click(screen.getByRole("button", { name: "pick-host" }));
    fireEvent.change(select(), { target: { value: "img-ready" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockCreateEnvironment).toHaveBeenCalled());
    expect(mockCreateEnvironment.mock.calls[0]![0]).toMatchObject({
      projectId: "proj-1",
      hostId: "host-1",
      computerEnvironmentId: "img-ready",
    });
  });
});

describe("option list states", () => {
  it("suffixes not-built images and disables personal drafts", () => {
    renderEditor(envRow());
    const options = Array.from(select().options).map((o) => ({
      label: o.text,
      disabled: o.disabled,
    }));
    expect(options).toContainEqual({ label: "Node 20", disabled: false });
    expect(options).toContainEqual({
      label: "Py 3.12 (not built)",
      disabled: false,
    });
    expect(options).toContainEqual({
      label: "My draft (draft — promote to project first)",
      disabled: true,
    });
  });

  it("keeps a deleted pinned image visible instead of coercing to None", () => {
    mockSandboxImages.value = [IMAGE_READY];
    renderEditor(envRow({ computerEnvironmentId: "img-gone" }));
    expect(select().value).toBe("img-gone");
    const orphan = Array.from(select().options).find((o) =>
      o.text.startsWith("Unknown image")
    );
    expect(orphan).toBeDefined();
    expect(orphan!.disabled).toBe(true);
  });
});
