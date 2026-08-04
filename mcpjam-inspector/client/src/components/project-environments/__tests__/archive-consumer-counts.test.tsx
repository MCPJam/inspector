/**
 * The archive-confirm dialog reports BOTH consumer counts (Phase 4). Before,
 * it named only suites and disclaimed that journeys weren't scanned; now the
 * copy states the suite AND journey counts, still hedged as advisory.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFlagValue, mockListEnvironments, mockConsumers } = vi.hoisted(
  () => ({
    mockFlagValue: { value: true as boolean | undefined },
    mockListEnvironments: vi.fn(() => [] as unknown[]),
    mockConsumers: {
      value: { suiteCount: 0, journeyCount: 0, chatboxCount: 0 } as {
        suiteCount: number | null;
        journeyCount: number | null;
        chatboxCount: number | null;
      },
    },
  })
);

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => mockFlagValue.value,
}));
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
  useProjectEnvironmentConsumers: () => mockConsumers.value,
}));
// Every case here clicks a row into DETAIL mode, which now mounts the
// read-only Connect canvas. The real panel reads Convex (`useHost`), and this
// suite has no ConvexProvider — stub it out; the consumer copy is the subject.
vi.mock("../EnvironmentCanvasPanel", () => ({
  EnvironmentCanvasPanel: () => <div data-testid="stub-env-canvas" />,
}));

import { ProjectEnvironmentsRoute } from "../ProjectEnvironmentsRoute";

const environment = {
  environmentId: "env-1",
  projectId: "proj-1",
  name: "Prod-like",
  hostId: "host-1",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

function renderAndOpenArchiveConfirm() {
  render(
    <MemoryRouter initialEntries={["/environments"]}>
      <Routes>
        <Route
          path="/environments"
          element={
            <ProjectEnvironmentsRoute
              isAuthenticated
              projectId="proj-1"
              canManage
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
  // List → detail → archive confirm.
  fireEvent.click(screen.getByText("Prod-like"));
  fireEvent.click(screen.getByRole("button", { name: /^archive$/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFlagValue.value = true;
  mockListEnvironments.mockReturnValue([environment]);
});

describe("archive-confirm consumer counts", () => {
  it("names both the suite and the journey counts", () => {
    mockConsumers.value = { suiteCount: 2, journeyCount: 3, chatboxCount: 0 };
    renderAndOpenArchiveConfirm();

    const summary = screen.getByText(/reference it/i);
    expect(summary.textContent).toMatch(/2 suites/);
    expect(summary.textContent).toMatch(/3 journeys/);
  });

  it("reports zero of each (not 'journeys aren't scanned') when nothing references it", () => {
    mockConsumers.value = { suiteCount: 0, journeyCount: 0, chatboxCount: 0 };
    renderAndOpenArchiveConfirm();

    expect(
      screen.getByText(/no referencing suites or journeys found/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/aren't scanned/i)).not.toBeInTheDocument();
  });

  it("singularizes a single journey reference", () => {
    mockConsumers.value = { suiteCount: 0, journeyCount: 1, chatboxCount: 0 };
    renderAndOpenArchiveConfirm();

    const summary = screen.getByText(/reference it/i);
    expect(summary.textContent).toMatch(/0 suites and 1 journey\b/);
  });

  it("shows a checking state until both scans settle", () => {
    mockConsumers.value = { suiteCount: 2, journeyCount: null, chatboxCount: 0 };
    renderAndOpenArchiveConfirm();

    expect(screen.getByText(/checking references/i)).toBeInTheDocument();
  });

  it("holds the checking state until the chatbox scan settles too (Phase 5)", () => {
    mockConsumers.value = { suiteCount: 2, journeyCount: 3, chatboxCount: null };
    renderAndOpenArchiveConfirm();

    expect(screen.getByText(/checking references/i)).toBeInTheDocument();
  });

  it("warns that a published chatbox link stops working immediately (Phase 5)", () => {
    mockConsumers.value = { suiteCount: 0, journeyCount: 0, chatboxCount: 1 };
    renderAndOpenArchiveConfirm();

    expect(
      screen.getByText(/chatbox link stops working immediately/i)
    ).toBeInTheDocument();
  });
});
