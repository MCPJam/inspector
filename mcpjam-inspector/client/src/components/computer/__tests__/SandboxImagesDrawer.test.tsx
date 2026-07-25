import { render, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SandboxImageView,
  SandboxImageBuildView,
} from "@/hooks/useSandboxImages";

let mockEnvironments: SandboxImageView[] | undefined = [];
const createEnvironment = vi.fn(async () => env({ environmentId: "new" }));
const updateEnvironment = vi.fn(async () => env());
const startBuild = vi.fn(async () => ({ buildId: "b1", reused: false }));
const promote = vi.fn(async () => env());
const deleteEnvironment = vi.fn(async () => ({ deleted: true as const }));
const setComputerEnvironment = vi.fn(async () => ({
  computerId: "c1",
  status: "provisioning",
}));

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/hooks/useSandboxImages", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/useSandboxImages")
  >("@/hooks/useSandboxImages");
  return {
    ...actual,
    useSandboxImages: () => mockEnvironments,
    useCreateSandboxImage: () => createEnvironment,
    useUpdateSandboxImage: () => updateEnvironment,
    useStartSandboxImageBuild: () => startBuild,
    usePromoteSandboxImage: () => promote,
    useDeleteSandboxImage: () => deleteEnvironment,
    useSetComputerSandboxImage: () => setComputerEnvironment,
  };
});

vi.mock("@/lib/toast", () => ({
  toast: { error: toastError, success: toastSuccess },
}));

import { SandboxImagesDrawer } from "../SandboxImagesDrawer";

function build(
  over: Partial<SandboxImageBuildView> = {}
): SandboxImageBuildView {
  return {
    buildId: "b1",
    status: "ready",
    provider: "stub",
    baseImageDigests: [],
    createdAt: 0,
    ...over,
  };
}

function env(over: Partial<SandboxImageView> = {}): SandboxImageView {
  return {
    environmentId: "env1",
    projectId: "p1",
    name: "ml-toolkit",
    dockerfile: "FROM debian@sha256:x\nRUN echo hi",
    contentHash: "h",
    sharing: "user",
    isOwner: true,
    currentBuild: build(),
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function renderDrawer(
  attachedEnvironmentId: string | null = null,
  canAttach = true
) {
  return render(
    <SandboxImagesDrawer
      open
      onOpenChange={() => {}}
      projectId="p1"
      attachedEnvironmentId={attachedEnvironmentId}
      canAttach={canAttach}
    />
  );
}

afterEach(() => {
  vi.clearAllMocks();
  mockEnvironments = [];
});

describe("SandboxImagesDrawer", () => {
  it("lists the base image + environments", () => {
    mockEnvironments = [env({ name: "ml-toolkit" })];
    const { getByText } = renderDrawer();
    expect(getByText("Base image")).toBeTruthy();
    expect(getByText("ml-toolkit")).toBeTruthy();
  });

  it("shows an empty state with a create affordance", () => {
    mockEnvironments = [];
    const { getByText } = renderDrawer();
    expect(getByText(/No custom environments yet/i)).toBeTruthy();
    expect(getByText("New environment")).toBeTruthy();
  });

  it("creates an environment from the new form", async () => {
    const { getByText, getByPlaceholderText } = renderDrawer();
    fireEvent.click(getByText("New environment"));
    fireEvent.change(getByPlaceholderText("Environment name"), {
      target: { value: "scraper" },
    });
    fireEvent.click(getByText("Create"));
    await waitFor(() =>
      expect(createEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "p1", name: "scraper" })
      )
    );
  });

  it("lands on the new env's detail right after create, before the list refreshes", async () => {
    createEnvironment.mockResolvedValueOnce(
      env({ environmentId: "new1", name: "fresh", currentBuild: null })
    );
    mockEnvironments = []; // the reactive list hasn't picked up the new row yet
    const { getByText, getByPlaceholderText } = renderDrawer();
    fireEvent.click(getByText("New environment"));
    fireEvent.change(getByPlaceholderText("Environment name"), {
      target: { value: "fresh" },
    });
    fireEvent.click(getByText("Create"));
    // The detail view (its Build button) shows even though `environments` is [].
    await waitFor(() => expect(getByText("Build")).toBeTruthy());
  });

  it("trailing whitespace in the name doesn't count as an unsaved change", () => {
    mockEnvironments = [env()]; // ready build, name "ml-toolkit"
    const { getByText, getByDisplayValue } = renderDrawer();
    fireEvent.click(getByText("ml-toolkit"));
    fireEvent.change(getByDisplayValue("ml-toolkit"), {
      target: { value: "ml-toolkit  " },
    });
    // dirty stays false (trimmed === env.name) → attach is not blocked by it.
    expect((getByText("Use on computer") as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it("disables 'Use on computer' until there is a ready build", () => {
    mockEnvironments = [env({ currentBuild: build({ status: "building" }) })];
    const { getByText } = renderDrawer();
    fireEvent.click(getByText("ml-toolkit"));
    expect((getByText("Use on computer") as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("does not start a build when the dirty save fails", async () => {
    updateEnvironment.mockRejectedValueOnce(new Error("save failed"));
    mockEnvironments = [env()];
    const { getByText, getByDisplayValue } = renderDrawer();
    fireEvent.click(getByText("ml-toolkit"));
    // Rename to make the editor dirty so Build saves first.
    fireEvent.change(getByDisplayValue("ml-toolkit"), {
      target: { value: "renamed" },
    });
    fireEvent.click(getByText("Build"));
    await waitFor(() => expect(updateEnvironment).toHaveBeenCalled());
    expect(startBuild).not.toHaveBeenCalled();
  });

  it("disables 'Use on computer' while the computer is mid-provision (canAttach=false)", () => {
    mockEnvironments = [env()]; // ready build
    const { getByText } = renderDrawer(null, false);
    fireEvent.click(getByText("ml-toolkit"));
    expect((getByText("Use on computer") as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("saves unsaved edits before sharing to the project", async () => {
    mockEnvironments = [env()];
    const { getByText, getByDisplayValue } = renderDrawer();
    fireEvent.click(getByText("ml-toolkit"));
    fireEvent.change(getByDisplayValue("ml-toolkit"), {
      target: { value: "renamed" },
    });
    fireEvent.click(getByText("Share with project"));
    await waitFor(() => expect(promote).toHaveBeenCalled());
    // Order matters: the save must complete before the promote.
    expect(updateEnvironment.mock.invocationCallOrder[0]).toBeLessThan(
      promote.mock.invocationCallOrder[0]!
    );
  });

  it("does not share when the pre-share save fails", async () => {
    updateEnvironment.mockRejectedValueOnce(new Error("save failed"));
    mockEnvironments = [env()];
    const { getByText, getByDisplayValue } = renderDrawer();
    fireEvent.click(getByText("ml-toolkit"));
    fireEvent.change(getByDisplayValue("ml-toolkit"), {
      target: { value: "renamed" },
    });
    fireEvent.click(getByText("Share with project"));
    await waitFor(() => expect(updateEnvironment).toHaveBeenCalled());
    expect(promote).not.toHaveBeenCalled();
  });

  it("confirms the data loss before changing the image, then attaches", async () => {
    mockEnvironments = [env()];
    const { getByText } = renderDrawer();
    fireEvent.click(getByText("ml-toolkit"));
    // First click only asks for confirmation — no mutation yet.
    fireEvent.click(getByText("Use on computer"));
    expect(
      getByText(/All files on this computer will be deleted/i)
    ).toBeTruthy();
    expect(setComputerEnvironment).not.toHaveBeenCalled();
    // Confirm.
    fireEvent.click(getByText("Change"));
    await waitFor(() =>
      expect(setComputerEnvironment).toHaveBeenCalledWith({
        projectId: "p1",
        environmentId: "env1",
      })
    );
  });

  it("cancelling the image-change confirm does not attach", () => {
    mockEnvironments = [env()];
    const { getByText } = renderDrawer();
    fireEvent.click(getByText("ml-toolkit"));
    fireEvent.click(getByText("Use on computer"));
    fireEvent.click(getByText("Cancel"));
    expect(setComputerEnvironment).not.toHaveBeenCalled();
  });

  it("surfaces an attach rejection as an error toast", async () => {
    setComputerEnvironment.mockRejectedValueOnce(
      new Error("[CONVEX] incompatible builder")
    );
    mockEnvironments = [env()];
    const { getByText } = renderDrawer();
    fireEvent.click(getByText("ml-toolkit"));
    fireEvent.click(getByText("Use on computer"));
    fireEvent.click(getByText("Change"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining("incompatible builder")
      )
    );
  });

  it("confirms the data loss before switching to the base image", async () => {
    mockEnvironments = [env()];
    // A custom env is attached, so the base row is actionable ("Use").
    const { getByText } = renderDrawer("env1");
    fireEvent.click(getByText("Base image"));
    expect(
      getByText(
        /Switch to the base image\? All files on this computer will be deleted/i
      )
    ).toBeTruthy();
    expect(setComputerEnvironment).not.toHaveBeenCalled();
    fireEvent.click(getByText("Switch"));
    await waitFor(() =>
      expect(setComputerEnvironment).toHaveBeenCalledWith({
        projectId: "p1",
        environmentId: null,
      })
    );
  });
});
