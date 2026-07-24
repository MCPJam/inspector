import { render, screen } from "@testing-library/react";
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

function renderAtEnvironments() {
  return render(
    <MemoryRouter initialEntries={["/environments"]}>
      <Routes>
        <Route
          path="/environments"
          element={<ProjectEnvironmentsRoute projectId="proj-1" canManage />}
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
