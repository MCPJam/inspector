import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFlagValue, mockListEnvironments } = vi.hoisted(() => ({
  mockFlagValue: { value: undefined as boolean | undefined },
  mockListEnvironments: vi.fn(() => [] as unknown[]),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => mockFlagValue.value,
}));

// The flag gate is the unit under test; the data hooks and the (heavy)
// editor subtree are stubbed out.
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: (projectId: string | null) =>
    projectId ? mockListEnvironments() : undefined,
  useArchiveProjectEnvironment: () => vi.fn(),
  useRestoreProjectEnvironment: () => vi.fn(),
}));
vi.mock("../ProjectEnvironmentEditor", () => ({
  ProjectEnvironmentEditor: () => <div>Environment Editor</div>,
}));
vi.mock("../use-project-environment-consumers", () => ({
  useProjectEnvironmentConsumers: () => ({ suiteCount: null }),
}));

import { ProjectEnvironmentsRoute } from "../ProjectEnvironmentsRoute";

function renderAtEnvironments(projectId = "proj-1") {
  return render(
    <MemoryRouter initialEntries={["/environments"]}>
      <Routes>
        <Route
          path="/environments"
          element={<ProjectEnvironmentsRoute projectId={projectId} canManage />}
        />
        <Route path="/servers" element={<div>Servers Screen</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("ProjectEnvironmentsRoute flag gate", () => {
  beforeEach(() => {
    mockFlagValue.value = undefined;
    mockListEnvironments.mockClear();
  });

  it("redirects a direct /environments visit to /servers when the flag is OFF", () => {
    mockFlagValue.value = false;
    renderAtEnvironments();
    expect(screen.getByText("Servers Screen")).toBeInTheDocument();
    expect(screen.queryByText("Environments")).not.toBeInTheDocument();
  });

  it("renders nothing (no redirect, no content) while the flag is loading", () => {
    mockFlagValue.value = undefined;
    renderAtEnvironments();
    expect(screen.queryByText("Servers Screen")).not.toBeInTheDocument();
    expect(screen.queryByText("Environments")).not.toBeInTheDocument();
  });

  it("renders the management screen when the flag is ON", () => {
    mockFlagValue.value = true;
    renderAtEnvironments();
    expect(
      screen.getByRole("heading", { name: "Environments" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Servers Screen")).not.toBeInTheDocument();
  });

  it("never fires the environments query while the flag is off", () => {
    mockFlagValue.value = false;
    renderAtEnvironments();
    expect(mockListEnvironments).not.toHaveBeenCalled();
  });
});

describe("ProjectEnvironmentsRoute project switch", () => {
  beforeEach(() => {
    mockFlagValue.value = true;
    mockListEnvironments.mockClear().mockReturnValue([]);
  });

  it("closes an open create form when the active project changes", () => {
    // The route is not keyed on projectId, so without an explicit reset the
    // editor would stay open holding the PREVIOUS project's picks while bound
    // to the new projectId.
    const { rerender } = renderAtEnvironments("proj-1");
    fireEvent.click(screen.getByRole("button", { name: /new environment/i }));
    expect(screen.getByText("Environment Editor")).toBeInTheDocument();

    rerender(
      <MemoryRouter initialEntries={["/environments"]}>
        <Routes>
          <Route
            path="/environments"
            element={<ProjectEnvironmentsRoute projectId="proj-2" canManage />}
          />
          <Route path="/servers" element={<div>Servers Screen</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.queryByText("Environment Editor")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Environments" })
    ).toBeInTheDocument();
  });
});
