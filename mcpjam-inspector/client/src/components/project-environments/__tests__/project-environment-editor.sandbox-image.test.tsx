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
 *
 * The picker is the app's own `Select` (Radix), not a native `<select>`, so the
 * option rows only exist in the DOM while the dropdown is open — hence the
 * open-then-read helpers below.
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  HostPicker: ({ onChange }: { onChange: (hostId: string | null) => void }) => (
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
// The secrets picker is a sibling section, not what these tests are about. It
// is stubbed rather than mocked at the hook level because it reads a live
// Convex query, and a real one here would need the whole provider.
vi.mock("../ProjectEnvironmentSecretsPicker", () => ({
  ProjectEnvironmentSecretsPicker: () => <div />,
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
    />,
  );
}

const trigger = () => screen.getByTestId("project-environment-sandbox-image");

/** Open the dropdown and pick a row by its visible label. */
async function pickImage(name: string | RegExp) {
  await userEvent.click(trigger());
  await userEvent.click(await screen.findByRole("option", { name }));
}

/** The option rows, readable only while the dropdown is open. */
async function openOptions() {
  await userEvent.click(trigger());
  const listbox = await screen.findByRole("listbox");
  return within(listbox)
    .getAllByRole("option")
    .map((option) => ({
      label: option.textContent ?? "",
      // Radix marks a disabled row with aria-disabled, not the DOM property a
      // native <option> would carry.
      disabled: option.getAttribute("aria-disabled") === "true",
    }));
}

describe("flag gating + the omission contract", () => {
  it("hides the picker when computers-enabled is off", () => {
    mockComputersEnabled.value = false;
    renderEditor(envRow());
    expect(
      screen.queryByTestId("project-environment-sandbox-image"),
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
        (mockUpdateEnvironment.mock.calls[0]![0] as Record<string, unknown>),
    ).toBe(false);
  });
});

describe("flag flips false AFTER an edit (review regression)", () => {
  it("omits the pin when the flag turns off between editing and saving", async () => {
    const { rerender } = renderEditor(
      envRow({ computerEnvironmentId: "img-ready" }),
    );
    // Admin clears the pin while the picker is visible…
    await pickImage("None (default image)");
    // …then PostHog re-evaluates the flag to false and the picker unmounts.
    mockComputersEnabled.value = false;
    rerender(
      <ProjectEnvironmentEditor
        projectId="proj-1"
        environment={envRow({ computerEnvironmentId: "img-ready" })}
        canManage
      />,
    );
    expect(
      screen.queryByTestId("project-environment-sandbox-image"),
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
    await pickImage("Node 20");

    mockComputersEnabled.value = false;
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
      "computerEnvironmentId" in
        (mockCreateEnvironment.mock.calls[0]![0] as Record<string, unknown>),
    ).toBe(false);
  });
});

describe("loading state (review regression)", () => {
  it("does not flash 'Unknown image' while the image list is still loading", async () => {
    mockSandboxImages.value = undefined;
    renderEditor(envRow({ computerEnvironmentId: "img-ready" }));
    // The pin still reads as selected rather than collapsing to "None" — a
    // control whose value matches no row would display the first one, which
    // would make a pinned environment look unpinned mid-load.
    expect(trigger()).toHaveTextContent("Loading image…");
    const options = await openOptions();
    expect(options.some((o) => o.label.startsWith("Unknown image"))).toBe(
      false,
    );
    expect(options).toContainEqual({
      label: "Loading image…",
      disabled: true,
    });
  });
});

describe("wire shapes", () => {
  it("attach sends the id on update", async () => {
    renderEditor(envRow());
    await pickImage("Node 20");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdateEnvironment).toHaveBeenCalled());
    expect(mockUpdateEnvironment.mock.calls[0]![0]).toMatchObject({
      expectedRevision: 3,
      computerEnvironmentId: "img-ready",
    });
  });

  it("clear sends null on update", async () => {
    renderEditor(envRow({ computerEnvironmentId: "img-ready" }));
    await pickImage("None (default image)");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockUpdateEnvironment).toHaveBeenCalled());
    expect(
      (mockUpdateEnvironment.mock.calls[0]![0] as Record<string, unknown>)
        .computerEnvironmentId,
    ).toBeNull();
  });

  it("create includes the id only when selected", async () => {
    renderEditor(null);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "New env" },
    });
    fireEvent.click(screen.getByRole("button", { name: "pick-host" }));
    await pickImage("Node 20");
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
  it("suffixes not-built images and disables personal drafts", async () => {
    renderEditor(envRow());
    const options = await openOptions();
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

  it("keeps a deleted pinned image visible instead of coercing to None", async () => {
    mockSandboxImages.value = [IMAGE_READY];
    renderEditor(envRow({ computerEnvironmentId: "img-gone" }));
    expect(trigger()).toHaveTextContent("Unknown image (img-gone)");
    const orphan = (await openOptions()).find((o) =>
      o.label.startsWith("Unknown image"),
    );
    expect(orphan).toEqual({
      label: "Unknown image (img-gone)",
      disabled: true,
    });
  });
});
