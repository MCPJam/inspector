/**
 * Every `projectEnvironments:*` MUTATION the environments UI sends must carry
 * `projectId` — the backend scopes both the admin check and the row lookup by
 * it, so a payload without it fails validation before the handler runs
 * (`ArgumentValidationError: Object is missing the required field projectId`).
 *
 * The hook arg types are hand-written mirrors of the Convex validators and the
 * functions are referenced by string id, so nothing type-checks this: update,
 * archive and restore all shipped without `projectId` and only create was
 * correct. That is why this suite asserts the WIRE PAYLOAD of the real
 * components rather than the hooks' types — a mirror can drift again, but a
 * payload assertion fails when it does.
 *
 * The route is rendered (not the editor alone) so all three payloads come from
 * the real call sites a user reaches: save from the detail pane's editor,
 * archive from its confirm, restore from the archived banner.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockListEnvironments,
  mockUpdateEnvironment,
  mockArchiveEnvironment,
  mockRestoreEnvironment,
} = vi.hoisted(() => ({
  mockListEnvironments: vi.fn(() => [] as unknown[]),
  mockUpdateEnvironment: vi.fn(),
  mockArchiveEnvironment: vi.fn(),
  mockRestoreEnvironment: vi.fn(),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => true,
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: (projectId: string | null) =>
    projectId ? mockListEnvironments() : undefined,
  useCreateProjectEnvironment: () => vi.fn(),
  useUpdateProjectEnvironment: () => mockUpdateEnvironment,
  useArchiveProjectEnvironment: () => mockArchiveEnvironment,
  useRestoreProjectEnvironment: () => mockRestoreEnvironment,
  isRevisionConflictError: () => false,
}));
// Both flag-gated editor sections stay OFF: their pickers are irrelevant here
// and their omission contract is covered by the sandbox-image/skills suites.
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => false,
}));
vi.mock("@/hooks/useSkillsEnabled", () => ({ useSkillsEnabled: () => false }));
// The secrets picker is a sibling section, not what this test is about, and it
// reads a live Convex query — a real one here would need the whole provider.
vi.mock("../ProjectEnvironmentSecretsPicker", () => ({
  ProjectEnvironmentSecretsPicker: () => <div />,
}));
vi.mock("@/hooks/useSandboxImages", () => ({
  useSandboxImages: () => undefined,
}));
// Convex-reading children of the detail pane; the payloads are the subject.
vi.mock("@/components/hosts/HostPicker", () => ({
  HostPicker: () => <div data-testid="host-picker" />,
}));
vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: () => <div data-testid="server-group-picker" />,
}));
vi.mock("../EnvironmentCanvasPanel", () => ({
  EnvironmentCanvasPanel: () => <div data-testid="stub-env-canvas" />,
}));
vi.mock("../use-project-environment-consumers", () => ({
  useProjectEnvironmentConsumers: () => ({
    suiteCount: 0,
    journeyCount: 0,
    scenarioCount: 0,
  }),
}));
vi.mock("@/hooks/useScenarios", () => ({
  useEnvironmentScenario: () => ({ scenario: null, isLoading: false }),
}));
vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/lib/convex-error", () => ({
  convexErrMessage: (_e: unknown, fallback: string) => fallback,
}));

import { ProjectEnvironmentsRoute } from "../ProjectEnvironmentsRoute";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

const PROJECT_ID = "proj-1";

function envRow(
  overrides: Partial<ProjectEnvironmentView> = {},
): ProjectEnvironmentView {
  return {
    environmentId: "env-1",
    projectId: PROJECT_ID,
    name: "Prod-like",
    hostId: "host-1",
    revision: 3,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** List → detail for the single row the list hook returns. */
function renderDetail(environment: ProjectEnvironmentView) {
  mockListEnvironments.mockReturnValue([environment]);
  render(
    <MemoryRouter initialEntries={["/environments"]}>
      <Routes>
        <Route
          path="/environments"
          element={
            <ProjectEnvironmentsRoute
              isAuthenticated
              projectId={PROJECT_ID}
              canManage
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText("Prod-like"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateEnvironment.mockResolvedValue(envRow({ revision: 4 }));
  mockArchiveEnvironment.mockResolvedValue(envRow({ revision: 4 }));
  mockRestoreEnvironment.mockResolvedValue(envRow({ revision: 4 }));
});

describe("projectId is sent with every environment mutation", () => {
  it("update carries projectId alongside the changed fields", async () => {
    renderDetail(envRow());
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockUpdateEnvironment).toHaveBeenCalled());
    expect(mockUpdateEnvironment.mock.calls[0]![0]).toMatchObject({
      projectId: PROJECT_ID,
      environmentId: "env-1",
      expectedRevision: 3,
      name: "Renamed",
    });
  });

  it("archive carries projectId", async () => {
    renderDetail(envRow());
    // Archive button → confirm strip → the destructive confirm.
    fireEvent.click(screen.getByRole("button", { name: /^archive$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^archive$/i }));

    await waitFor(() => expect(mockArchiveEnvironment).toHaveBeenCalled());
    expect(mockArchiveEnvironment.mock.calls[0]![0]).toEqual({
      projectId: PROJECT_ID,
      environmentId: "env-1",
      expectedRevision: 3,
    });
  });

  it("restore carries projectId", async () => {
    renderDetail(envRow({ archivedAt: 123 }));
    fireEvent.click(screen.getByRole("button", { name: /^restore$/i }));

    await waitFor(() => expect(mockRestoreEnvironment).toHaveBeenCalled());
    expect(mockRestoreEnvironment.mock.calls[0]![0]).toEqual({
      projectId: PROJECT_ID,
      environmentId: "env-1",
      expectedRevision: 3,
    });
  });
});
