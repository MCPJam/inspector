import { render, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentView,
  EnvironmentBuildView,
} from "@/hooks/useComputerEnvironments";

let mockEnvironments: EnvironmentView[] | undefined = [];
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

vi.mock("@/hooks/useComputerEnvironments", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/useComputerEnvironments")
  >("@/hooks/useComputerEnvironments");
  return {
    ...actual,
    useEnvironments: () => mockEnvironments,
    useCreateEnvironment: () => createEnvironment,
    useUpdateEnvironment: () => updateEnvironment,
    useStartEnvironmentBuild: () => startBuild,
    usePromoteEnvironment: () => promote,
    useDeleteEnvironment: () => deleteEnvironment,
    useSetComputerEnvironment: () => setComputerEnvironment,
  };
});

vi.mock("@/lib/toast", () => ({
  toast: { error: toastError, success: toastSuccess },
}));

import { EnvironmentsDrawer } from "../EnvironmentsDrawer";

function build(over: Partial<EnvironmentBuildView> = {}): EnvironmentBuildView {
  return {
    buildId: "b1",
    status: "ready",
    provider: "stub",
    baseImageDigests: [],
    createdAt: 0,
    ...over,
  };
}

function env(over: Partial<EnvironmentView> = {}): EnvironmentView {
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

function renderDrawer(attachedEnvironmentId: string | null = null) {
  return render(
    <EnvironmentsDrawer
      open
      onOpenChange={() => {}}
      projectId="p1"
      attachedEnvironmentId={attachedEnvironmentId}
    />
  );
}

afterEach(() => {
  vi.clearAllMocks();
  mockEnvironments = [];
});

describe("EnvironmentsDrawer", () => {
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

  it("disables 'Use on computer' until there is a ready build", () => {
    mockEnvironments = [env({ currentBuild: build({ status: "building" }) })];
    const { getByText } = renderDrawer();
    fireEvent.click(getByText("ml-toolkit"));
    expect(
      (getByText("Use on computer") as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("attaches a ready environment to the computer", async () => {
    mockEnvironments = [env()];
    const { getByText } = renderDrawer();
    fireEvent.click(getByText("ml-toolkit"));
    fireEvent.click(getByText("Use on computer"));
    await waitFor(() =>
      expect(setComputerEnvironment).toHaveBeenCalledWith({
        projectId: "p1",
        environmentId: "env1",
      })
    );
  });

  it("surfaces an attach rejection as an error toast", async () => {
    setComputerEnvironment.mockRejectedValueOnce(
      new Error("[CONVEX] incompatible builder")
    );
    mockEnvironments = [env()];
    const { getByText } = renderDrawer();
    fireEvent.click(getByText("ml-toolkit"));
    fireEvent.click(getByText("Use on computer"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining("incompatible builder")
      )
    );
  });
});
